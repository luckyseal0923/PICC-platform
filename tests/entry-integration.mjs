// Real HTTP + real entry controller, against the disposable Python test database.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createEntryController} from "../client/entry-controller.js";
const base=new URL(process.argv[2]);
assert.equal(base.hostname,"127.0.0.1");
async function actor(){
  let cookie="";
  const paths=[];
  const fetcher=async(path,options={})=>{
    paths.push(path);const headers=new Headers(options.headers||{});if(cookie)headers.set("Cookie",cookie);
    const res=await fetch(new URL(path,base),{...options,headers});
    const setCookie=res.headers.get("set-cookie");if(setCookie)cookie=setCookie.split(";")[0];return res;
  };
  const controller=createEntryController({fetcher,adapter:()=>null,uuid:randomUUID});
  await controller.boot();assert.equal(controller.state.config.loginRequired,false);assert.equal(controller.state.actor.verified,false);
  return {controller,fetcher,paths};
}
const a=await actor(),b=await actor(),c=await actor();
for(const path of ["/picc-create/","/picc-booking/","/picc-report/"]){const res=await a.fetcher(path);assert.equal(res.status,200);}
const basic={bedNo:"TEST",mrn:"DEMO-ENTRY",patientName:"DEMO",remark:"Synthetic only",selfReport:false};
const report={operatorId:"demo-a",difficulty:"困難",insertionSite:"右上臂",vein:"Basilic",catheterType:"雙腔PICC",catheterLength:"42.5",remark:"Synthetic report"};
const created=await a.controller.create(basic);
assert.equal((await b.controller.list("booking"))[0].id,created.id);
const claimed=await b.controller.claim(created,"demo-b");
assert.equal((await b.controller.list("booking")).length,0);
assert.equal((await c.controller.list("report"))[0].id,claimed.id);
await c.controller.complete(claimed,report);
assert.equal((await c.controller.list("report")).length,0);
const toCancel=await a.controller.create({...basic,mrn:"DEMO-CANCEL"});
const waiting=await b.controller.claim(toCancel,"demo-b");
await c.controller.cancel(waiting,"其他","Synthetic cancellation");
assert.equal((await c.controller.list("report")).length,0);
const original=(await a.controller.detail(toCancel.id)).task;assert.equal(original.status,"cancelled");
const audit=(await a.controller.detail(toCancel.id)).events;
assert(audit.every(event=>event.actorName==="內部共用入口（未驗證操作者）"));
const reordered=await a.controller.create({...basic,copiedFromTaskId:original.id});
assert.notEqual(reordered.id,original.id);assert.equal(reordered.reorderOf,original.id);
assert.equal((await a.controller.detail(original.id)).task.status,"cancelled");
await a.controller.create({...basic,...report,operatorId:"demo-b",selfReport:true});
assert.equal([...b.paths,...c.paths].some(path=>/stats|notifications|announce/.test(path)),false);
assert.equal([...a.paths,...b.paths,...c.paths].some(path=>/\/auth\/|\/me$/.test(path)),false);
assert.equal((await a.fetcher("/api/stats")).status,401);
console.log("No-login entries: real HTTP create, booking, report, cancel/reorder, self-report and shared audit actor passed (synthetic database).");
