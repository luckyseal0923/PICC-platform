import {build} from "esbuild";
import {mkdir,copyFile,readFile,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
await build({entryPoints:["client/supabase-adapter.js"],bundle:true,format:"iife",target:["es2020"],outfile:"static/supabase-adapter.js",minify:true,legalComments:"eof"});
await build({entryPoints:["client/entry.js"],bundle:true,format:"iife",target:["es2020"],outfile:"static/entry.js",minify:true,legalComments:"eof"});
await build({entryPoints:["client/landing.js"],bundle:true,format:"iife",target:["es2020"],outfile:"static/landing.js",minify:true});
await import("./build-mobile-preview.mjs");
// Asset versions make existing browsers load the matching CSS and JS after a deployment.
const assetVersions={};
for(const file of ["styles.css","app.js","supabase-adapter.js","entry.css","entry.js","landing.js"]){
  assetVersions[file]=createHash("sha256").update(await readFile("static/"+file)).digest("hex").slice(0,12);
}
for(const file of ["index.html","entry.html","landing.html"]){
  const page=await readFile("static/"+file,"utf8");
  await writeFile("static/"+file,page.replace(/\/assets\/([a-z-]+\.(?:js|css))(?:\?v=[a-f0-9]+)?/g,(url,asset)=>assetVersions[asset]?"/assets/"+asset+"?v="+assetVersions[asset]:url));
}
await mkdir("dist/assets",{recursive:true});
for(const file of ["styles.css","app.js","config.js","supabase-adapter.js","entry.css","entry.js","landing.js"])await copyFile("static/"+file,"dist/assets/"+file);
await copyFile("static/landing.html","dist/index.html");
await mkdir("dist/workspace",{recursive:true});
await copyFile("static/index.html","dist/workspace/index.html");
for(const route of ["picc-create","picc-booking","picc-report"]){
  await mkdir("dist/"+route,{recursive:true});
  await copyFile("static/entry.html","dist/"+route+"/index.html");
}
console.log("Built static frontend in dist/. No deploy or GitHub push.");
