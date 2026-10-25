// The previous preview now opens the focused create entry, not the full dashboard.
import {readFile,writeFile} from "node:fs/promises";
let css=await readFile("static/entry.css","utf8");
css+="\n/* Preview frame only; the three live routes use normal responsive sizing. */\n"+
"body{width:min(390px,100%);min-height:100vh;margin:0 auto;box-shadow:0 0 0 1px var(--border)}\n"+
".entry-page{padding-left:16px;padding-right:16px}.page-heading h1{font-size:26px}\n";
await writeFile("static/mobile-preview.css",css);
const page=(await readFile("static/entry.html","utf8"))
  .replace("<title>PICC 手機入口</title>","<title>PICC 建案手機預覽 · 390px</title>")
  .replace(/href="\/assets\/entry\.css(?:\?v=[a-f0-9]+)?"/,'href="/assets/mobile-preview.css"');
await writeFile("static/mobile-preview.html",page);
console.log("Updated local mobile preview to the focused create entry.");
