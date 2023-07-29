// Define your validation function
import React from 'react';
import { Screen } from '../utils/Screen'; 
import { test } from 'components/test.jsx'

import { serialize, deserialize } from "react-serialize"

export class Login extends Screen {

    constructor(data) {
        super(data); //data is the data passed from the previous screen, if any; this.data
        this.state = { count: 0 };
        console.log('test2',serialize(test({ name:'Pedro' })));
        console.log('test2',serialize(test()));
    }

    componentDidMount() {
        // this runs on the client terminal lifecycle
        this.refs.usernameInput.focus();
        this.interval = setInterval(()=>{
            this.setState({count: this.state.count+1})
        },1000);
    }
    
    componentWillUnmount() {
        // this runs on the client terminal lifecycle
        clearInterval(this.interval);
    }

    //any method defined here is run on the client; called from layout
    //the code for these methods is sent to the client along the layout
    validatePassword() {
        return this.refs.passwordInput.value.length > 0;
    }

    // if you return tags from render, ensure the following:
    // - always use lowercase react-blessed tag names
    // - if you need to use variables within content, use [] instead of {}
    // if you return a string from render, then use it as if it was React:
    // - use {} to embed variables
    // - use capital letters for react-blessed tag components
    render() {
        return (
            <box label="Login" border={{ type: 'line' }} style={{ border: { fg: 'blue' } }}>
                <form id="loginForm">
                    <test name="Pepito" />
                    <label>Count: [this.state.count]</label>
                    <label>Username:</label>
                    <textbox name="username" id="usernameInput" />
                    <label>Password:</label>
                    <textbox name="password" type="password" id="passwordInput" />
                    <button type="submit" id="submitButton" onClick={()=>{
                        // this runs on the client terminal
                        const username = this.refs.usernameInput.value;
                        const password = this.refs.passwordInput.value;
                        // this is a method call on the client 
                        this.validatePassword();
                        // this triggers a call to the server (all this.server methods are awaited automatically)
                        const check = this.server.validateLoginForm({ username, password })
                        if (check.success) {
                            this.navigate(check.nextScreen, { message: check.message });
                        }
                        //redirect to another screen (makes client request given page to server)
                        //this.navigate("MainMenu",{} ); //optionally you can pass data to the next screen, which is assigned as this.data
                    }}>Login</button>
                </form>
                <ansiimage src="./assets/logo.gif" animated={true} />
            </box>
        )
    }

    // this is the only method that is called from the client on the server
    // data are the args sent from the client
    async server() {
        // these methods run on the server; called from layout
        // these methods are not sent to the client; only the result is sent
        return {
            validateLoginForm(data) {
                const { username, password } = data;
                // Implement your validation logic
                if (username === "admin" && password === "password") {
                    return {
                        success: true,
                        message: "Login Successful",
                        nextScreen: "MainMenu"
                    };
                } else {
                    return {
                        success: false,
                        message: "Invalid username or password"
                    };
                }
            }
        }
    }

}

/*
export const LoginScreen = {
    component,
    name: "LoginScreen",
    events: { validateLoginForm }
};*/