import * as screens from './screens'
import express from 'express'
import bodyParser from 'body-parser'

// init all screens
const Screens = {}, Screen4Client = {}; 
for (let screen in screens) {
    const xx = new screens[screen]();
    await xx._init();
    Screens[screen] = xx._getScreenData();
    Screen4Client[screen] = xx._getScreenData();
    Screen4Client[screen].serverFunctions = Object.keys(Screen4Client[screen].serverFunctions);
}
//console.log('Screens data',Screens);

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
    res.send({
        version: pkg.version,
        screens: Object.keys(Screens),
        startScreen: 'Login'
    });
});

// get given screen definition
router.get('/screen/:screenName', async(req, res) => {
    const { screenName } = req.params;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress 
    console.log(`[from ${ip}] Requested info for screen ${screenName}`);
    const screen = Screen4Client[screenName];
    if (screen) {
        res.send(screen);
    } else {
        res.status(404).send({ error: 'Screen not found' });
    }
});

// post data to given screen method and return result
router.post('/screen/:screenName/:methodName', async(req, res) => {
    const { screenName, methodName } = req.params;
    const screen = Screens[screenName];
    if (screen && screen.serverFunctions[methodName]) {
        try {
            const result = await screen.serverFunctions[methodName](req.body);
            res.send(result);
        } catch(err) {
            console.error('Error screen ('+screenName+') method ('+methodName+'):', { err, data:req.body });
            res.status(500).send({ error: err.message });
        }
    } else {
        res.status(404).send({ error: 'Screen not found' });
    }
});

app.use('/nodebbs', router);

app.listen(PORT, () => {
    console.log(`NodeBBS Server listening on port ${PORT}...`);
});