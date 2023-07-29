// Define your validation function
import React from 'react';
import { Screen } from '../utils/Screen'; 
import { test } from 'components/test.jsx'

export class NoAuth extends Screen {

    constructor(data) {
        super(data); //data is the data passed from the previous screen, if any; this.data
        this.state = { count: 0, from:'' };
        if (this.data.from) this.state.from = this.data.from;
    }

    render() {
        return (
            <box label="Error" border={{ type: 'line' }} style={{ border: { fg: 'red' } }}>
                <text>You're not authorized to access the screen [this.state.from]</text>
            </box>
        )
    }

}
