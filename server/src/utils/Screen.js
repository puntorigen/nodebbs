import { serialize, deserialize } from "react-serialize"
import reactElementToJSXString from 'react-element-to-jsx-string';
import LZString from 'lz-string';

//import React from 'react';
import blessed from 'blessed';
import blessed_contrib from 'blessed-contrib';
//import { render } from 'react-blessed'

export class Screen {
    constructor(data) {
        this.state = {};
        this.functions = {}; // inplace client functions declared on layout
        this.layout = this.render();
        this._layout = JSON.parse(serialize(this.layout));
        this.__layout = reactElementToJSXString(this.layout,{ showFunctions:true, functionValue:(x)=>{
            let func_code = x.toString();
            // replace all _thisx. with this., and all _this2. with this., and all _thisN. with this. on func var 
            func_code = func_code.replace(/_this\d*\./g,'this.');
            // get function name from func_code string
            const func_name = func_code.match(/function\s*(\w*)\s*\(/)[1];
            let new_func_name = func_name;
            // add function to functions object, if it exists, add number to end of function name
            if (this.functions[new_func_name]) {
                let i = 1;
                while (this.functions[new_func_name+i]) {
                    i++;
                }
                new_func_name = new_func_name+i;
            }
            // if the function code doesn't start with async, add async to it
            if (!func_code.startsWith('async')) func_code = 'async '+func_code;
            // replace original func_name on func_code string with new func_name
            this.functions[new_func_name] = func_code.replaceAll(func_name,new_func_name);
            //console.log('function',{ func_name, func_code });
            return 'this.'+new_func_name
        } });
        this.assets = {};
        this.lifecycle = {}; // lifecycle events, to run on the client
        this._events = {};
        this.data = data;
        this._clientFunctions = {};
        this._serverFunctions = {};
        this._customComponents = {};
        this._processReadyFlag = false; 
        this._init();
    }

    async _init() {
        await this._extractAssets();
        await this._process();
        this._processReadyFlag = true;
    }

    async _extractAssets() {
        // transform assets into a map of asset name to compressed asset data
        // extract assets from _layout obj
        const path = require('path'), fs = require('fs').promises;
        const fileExists = async(src)=>{ try { await fs.access(src); return true; } catch(e) { return false; } };
        const compressToUTF16 = LZString.compressToUTF16;
        const traverse = async (obj) => {
            for (let key in obj) {
                if (obj[key] && typeof obj[key] === 'object') {
                    if (typeof obj[key].props === 'object') {
                        if (typeof obj[key].props.src === 'string') {
                            //get absolute path of src, if it doesn't start with http
                            let src = obj[key].props.src;
                            if (!src.startsWith('http')) {
                                if (!src.startsWith('.')) {
                                    // absolute path from root
                                    src = path.join(process.cwd(),src);
                                } else {
                                    // relative path from src folder
                                    src = path.join(process.cwd(),'/src/',src);
                                }
                            } else {
                                // added support for http assets
                                // create /.cache folder if it doesn't exist
                                const cache = path.join(process.cwd(),'/cache/');
                                if (!await fileExists(cache)) {
                                    await fs.mkdir(cache);
                                }
                                // get filename from src, test if it doesn't exist on cache folder
                                const filename = src.split('/').pop();
                                src = path.join(cache,filename);
                                if (!await fileExists(src)) {
                                    // download asset bin to cache folder
                                    // const fetch = require('node-fetch');
                                    const res = await fetch(obj[key].props.src);
                                    const data = await res.buffer();
                                    // write data to ./cache folder
                                    await fs.writeFile(src,data);
                                }
                            }
                            //check that file src exists (async)
                            const exists = await fileExists(src);
                            if (exists) {
                                //read file contents
                                const data = await fs.readFile(src);
                                //convert compressed data to base64
                                const compressed = compressToUTF16(data.toString('base64'));
                                //const base64 = compressed.toString('base64');
                                this.assets[obj[key].props.src] = compressed;
                            } else {
                                //add src to assets map; file doesn't exist on server
                                this.assets[obj[key].props.src] = obj[key].props.src;
                            }
                        }
                    }
                    await traverse(obj[key]);
                }
            }
        }
        await traverse(this._layout);
    }

    async _extractCustomComponents() {
        const fs = require('fs').promises, path = require('path');
        // extract and export custom components code, for client to use
        // get the value of those keys, and add the function code toString as value for each key
        // filter only the keys that start with an uppercase letter
        const blessedKeys = Object.keys(blessed).filter(x=>x[0]===x[0].toUpperCase());
        const _blessedKeys = blessedKeys;
        // get blessed_contrib keys as well, and merge with blessedKeys obj
        Object.keys(blessed_contrib).filter(x=>x[0]===x[0].toUpperCase()).forEach((key)=>blessedKeys[key]=key);
        // lowercase all blessedKeys
        blessedKeys.forEach((key,i)=>blessedKeys[i]=key.toLowerCase());
        //console.log('blessed & contrib tags',blessedKeys);
        // traverse the this._layout tree for 'type' key values
        // detect type value keys that are not within blessedKeys keys
        const traverse = async (obj) => {
            for (let key in obj) {
                if (obj[key] && typeof obj[key] === 'object') {
                    if (typeof obj[key].type === 'string' && obj[key].props) {
                        if (!blessedKeys.includes(obj[key].type)) {
                            // add to customComponents
                            this._customComponents[obj[key].type] = obj[key].type;
                        }
                    }
                    await traverse(obj[key]);
                }
            }
        }
        await traverse(this._layout);
        // for each this._customComponents key, get the source code for that component
        // and add it to this._customComponents as value, iterate using for
        for (let key in this._customComponents) {
            // get the source code for that component from ../components dir
            const src = path.join(process.cwd(),'/src/components/',key+'.jsx');
            const exists = await fs.access(src).then(()=>true).catch(()=>false);
            if (exists) {
                // read file contents
                const data = await fs.readFile(src);
                this._customComponents[key] = data.toString();
            }
        };
    }

    async _process() {
        await this._extractCustomComponents();
        const inspect = require('util').inspect;
        const dump = (data)=>inspect(data, { depth: null });
        //console.log('layout',dump(this._layout));
        //console.log('assets',Object.keys(this.assets).map((key)=>({key,bytes:this.assets[key].length }))); //.dump(this.assets));
        //console.log('state',dump(this.state));
        //console.log('functions',dump(this.functions));
        // add lifecycle events code to lifecycle obj (to send them to client)
        if (this.componentDidMount) this.lifecycle.componentDidMount = this.componentDidMount.toString().replace(/_this\d*\./g,'this.');
        if (this.componentWillUnmount) this.lifecycle.componentWillUnmount = this.componentWillUnmount.toString().replace(/_this\d*\./g,'this.');
        if (this.componentDidUpdate) this.lifecycle.componentDidUpdate = this.componentDidUpdate.toString().replace(/_this\d*\./g,'this.');
        if (this.componentDidCatch) this.lifecycle.componentDidCatch = this.componentDidCatch.toString().replace(/_this\d*\./g,'this.');
        //
        //console.log('lifecycle functions',dump(this.lifecycle));
        // server functions
        const s = await this.server();
        for (let key in s) {
            if (typeof s[key] === 'function') {
                this._serverFunctions[key] = s[key]; //.toString().replace(/_this\d*\./g,'this.');
            }
        }
        //console.log('server functions',dump(serverEvents));
        // client functions
        // get list of methods defined on instance 
        const proto = Object.getPrototypeOf(this);
        this._clientFunctions = Object.getOwnPropertyNames(proto).filter(x=>x!=='constructor');
        // remove methods that are defined on this.lifecycle, are 'render' or 'server' method
        this._clientFunctions = this._clientFunctions.filter(x=>!this.lifecycle[x] && x!=='render' && x!=='server');
        // add functions code toString as value for each clientFunction key
        this._clientFunctions = this._clientFunctions.reduce((acc,cur)=>{
            acc[cur] = this[cur].toString().replace(/_this\d*\./g,'this.');
            return acc;
        },{});
        //console.log('client functions',dump(clientFunctions));
    }

    _getScreenData() {
        // return data to /index.js
        return {
            layout: this.__layout, // layout as string
            //layoutObj: this._layout, // layout as obj
            assets: this.assets,  // map of asset name to compressed asset data
            state: this.state, // initial state declared on screen
            functions: this.functions, // inplace client functions declared on layout
            lifecycle: this.lifecycle, // lifecycle events, to run on the client
            clientFunctions: this._clientFunctions, // custom client methods defined on screen
            serverFunctions: this._serverFunctions, // custom server methods defined on screen; to be called from express post route
            customComponents: this._customComponents, // custom components imported & used on screen layout
        };
    }

}