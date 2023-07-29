import React from 'react'
import blessed from 'blessed'
import { render } from 'react-blessed'

const App = () => {
    return (
        <box
            top="center"
            left="center"
            width="50%"
            height="50%"
            border={{ type: 'line' }}
            label='hola'
            style={{ border: { fg: 'blue' } }}
        >Hello World!</box>
    )
}

const screen = blessed.screen({
    autoPadding: true,
    smartCSR: true,
    title: 'NodeBBS Terminal Client'
})

screen.key(['escape', 'q', 'C-c'], () => process.exit(0))

render(<App />, screen);