export const parseScreen = (jsx) => {
    const jsxToObj = require('easy-jsx-parser');
    //const layoutObject = parseJSX(jsx);
    const layoutObject = jsxToObj(jsx);
    console.log(`parsing screen ${jsx}`, layoutObject);
    return layoutObject;
    const events = {};
  
    const traverse = (obj) => {
      for (let key in obj) {
        if (obj[key] && typeof obj[key] === 'object') {
          if (typeof obj[key].props === 'object') {
            for (let prop in obj[key].props) {
              if (typeof obj[key].props[prop] === 'function') {
                if (!events[obj[key].id]) {
                  events[obj[key].id] = {};
                }
                events[obj[key].id][prop] = obj[key].props[prop];
                delete obj[key].props[prop];
              }
            }
          }
          traverse(obj[key]);
        }
      }
    };
  
    traverse(layoutObject);
  
    return {
      layout: layoutObject,
      events: events
    };
  };