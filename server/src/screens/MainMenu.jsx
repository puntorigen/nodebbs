// Define your validation function
import React from 'react';
import { Screen } from '../utils/Screen'; 
import { test } from 'components/test.jsx'

export class MainMenu extends Screen {

    constructor(data) {
        super(data); //data is the data passed from the previous screen, if any; this.data
        this.state = { count: 0 };
        if (!this.data.token) {
            //if token wasn't given, redirect to login
            //redirect to another screen (server makes virtual request to given page)
            this.navigate("Login",{});
        } else if (this.data.token!='test') {
            // you can validate the token here, and if invalid redirect the user before rendering
            this.navigate("NoAuth",{ from: "MainMenu" });
        }
    }

    componentDidMount() {
        // this runs on the client terminal lifecycle
    }
    
    componentWillUnmount() {
        // this runs on the client terminal lifecycle
    }

    render() {
        return (
            <box label="MainMenu" border={{ type: 'line' }} style={{ border: { fg: 'blue' } }}>
                <text>Main menu here</text>
            </box>
        )
    }

}
