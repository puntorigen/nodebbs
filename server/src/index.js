//import { toJSXString } from 'react-jsx-parser';
import * as screens from './screens'

//console.log('Login',screens.Login);

// init all screens
for (let screen in screens) {
    const xx = new screens[screen]();
    await xx._init();
    console.log('meta['+screen+']',xx._getScreenData());
}
/*const xx = new screens.Login();
await xx._init();
console.log('meta',xx._getScreenData());
*/