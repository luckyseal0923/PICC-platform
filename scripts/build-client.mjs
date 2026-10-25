import {build} from "esbuild";
import {mkdir,copyFile} from "node:fs/promises";
await build({entryPoints:["client/supabase-adapter.js"],bundle:true,format:"iife",target:["es2020"],outfile:"static/supabase-adapter.js",minify:true,legalComments:"eof"});
await build({entryPoints:["client/entry.js"],bundle:true,format:"iife",target:["es2020"],outfile:"static/entry.js",minify:true,legalComments:"eof"});
await import("./build-mobile-preview.mjs");
await mkdir("dist/assets",{recursive:true});
for(const file of ["styles.css","app.js","config.js","supabase-adapter.js","entry.css","entry.js"])await copyFile("static/"+file,"dist/assets/"+file);
await copyFile("static/entry.html","dist/index.html");
await mkdir("dist/workspace",{recursive:true});
await copyFile("static/index.html","dist/workspace/index.html");
for(const route of ["picc-create","picc-booking","picc-report"]){
  await mkdir("dist/"+route,{recursive:true});
  await copyFile("static/entry.html","dist/"+route+"/index.html");
}
console.log("Built static frontend in dist/. No deploy or GitHub push.");
