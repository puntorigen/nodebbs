import * as screens from './screens'
import express from 'express'
import bodyParser from 'body-parser'

// helper methods
const ScreensCache = {}; 
const getScreenData = async(screen, data={}) => {
    const data_ = JSON.stringify(data);
    if (ScreensCache[screen+data_]) return ScreensCache[screen+data_];
    const screenData = new screens[screen](data);
    await screenData._init();
    const info_ = screenData._getScreenData();
    if (!info_.invalid) {
        ScreensCache[screen+data_] = info_;
        return ScreensCache[screen+data_];
    } else {
        // if data was invalid, we don't cache it, and redirect if requested
        if (info_.meta && info_.meta.screen) {
            console.log('!request was invalid; redirect detected to',info_.meta.screen,'with data',info_.meta.data);
            const red = await getScreenData(info_.meta.screen, info_.meta.data);
            red.redirected_from = screen;
            return red;
        } else {
            // data was invalid and no redirect requested, return as it was
            return info_;
        }
    }
};

// init express
const app = express();
const router = express.Router();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// init routes
// public info nodebbs server
router.get('/', async(req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
    console.log(`[from ${ip}] NodeBBS info requested`);
    const pkg = require('../package.json');
    const nbbs = require('../nodebbs.json');
    if (nbbs.encrypted=="true") {
        // generate datetime based key
        nbbs.encryption_key = Date.now().toString();
    }
    res.send({
        version: pkg.version,
        description: (nbbs.description)?nbbs.description:pkg.description,
        screens: Object.keys(screens),
        meta: nbbs
    });
});

// get given screen definition
router.get('/screen/:screenName', async(req, res) => {
    const { screenName } = req.params;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
    // time how long it takes to get the screen data
    const start = Date.now();
    let data = await getScreenData(screenName, {});
    // list server functions
    // data.serverFunctionsNames = Object.keys(data.serverFunctions);
    // log how long it took to get the screen data
    const end = Date.now(); const ms = end - start;
    const bytes = JSON.stringify(data).length;
    console.log(`[from ${ip}] Requested info for screen ${screenName}, took ${ms}ms, ${bytes} bytes`);
    //
    if (data) {
        res.send(data);
    } else {
        res.status(404).send({ error: 'Screen not found' });
    }
});

// get given screen definition with data
router.post('/screen/:screenName', async(req, res) => {
    const { screenName } = req.params;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
    console.log(`[from ${ip}] Requested info for screen ${screenName} with data`,req.body);
    //
    let data = await getScreenData(screenName, req.body);
    // list server functions
    // data.serverFunctionsNames = Object.keys(data.serverFunctions);
    //
    if (data) {
        res.send(data);
    } else {
        res.status(404).send({ error: 'Screen not found' });
    }
});

// post data to given screen method and return result
router.post('/screen/:screenName/:methodName', async(req, res) => {
    const { screenName, methodName } = req.params;
    //const screen = Screens[screenName];
    const screen = await getScreenData(screenName, {});
    console.log('screen->method',screenName,methodName);
    if (screen && screen.serverFunctions[methodName]) {
        try {
            const result = await screen.serverFunctions[methodName](req.body);
            res.send(result);
        } catch(err) {
            console.error('Error screen ('+screenName+') method ('+methodName+'):', { err, data:req.body });
            res.status(500).send({ error: err.message });
        }
    } else {
        res.status(404).send({ error: 'Screen or method not found' });
    }
});

app.use('/nodebbs', router);

app.listen(PORT, () => {
    console.log(`NodeBBS Server listening on port ${PORT}...`);
});