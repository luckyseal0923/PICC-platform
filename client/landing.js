export function defaultRoute(viewportWidth){return viewportWidth<=680?"/picc-create/":"/workspace/";}
if(typeof window!=="undefined")window.location.replace(defaultRoute(window.innerWidth));
