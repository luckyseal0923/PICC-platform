import test from "node:test";
import assert from "node:assert/strict";
import {createEntryController,entryPage,ENTRY_ROUTES} from "../client/entry-controller.js";
import {defaultRoute} from "../client/landing.js";

const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}});
const shared={id:"00000000-0000-4000-8000-000000000001",name:"共用入口",role:"shared",verified:false};
test("home routes desktop to the full workspace and phone to the create entry",()=>{
  assert.equal(defaultRoute(390),"/picc-create/");assert.equal(defaultRoute(680),"/picc-create/");
  assert.equal(defaultRoute(681),"/workspace/");assert.equal(defaultRoute(1920),"/workspace/");
});
function scenario(handler,{config={},unavailable=()=>{}}={}){
  const calls=[];let sequence=0;
  const client=createEntryController({uuid:()=>"request-"+(++sequence),onUnavailable:unavailable,adapter:()=>null,
    fetcher:async(path,options={})=>{
      calls.push({path,options});
      if(path==="/api/entry/config")return response({demo:true,loginRequired:false,user:shared,csrf:"test-csrf",...config});
      return handler(path,options,calls);
    }});
  return {client,calls};
}

test("three entry routes request only their workflow status and omit unrelated rows",async()=>{
  assert.deepEqual(Object.values(ENTRY_ROUTES),["/picc-create/","/picc-booking/","/picc-report/"]);
  assert.equal(entryPage("/picc-booking"),"booking");assert.equal(entryPage("/picc-report/"),"report");
  const {client,calls}=scenario(()=>response({tasks:[{id:"a",status:"pending"},{id:"b",status:"claimed"},{id:"c",status:"completed"}]}));
  await client.boot();assert.deepEqual((await client.list("booking")).map(t=>t.id),["a"]);
  assert.equal(calls.at(-1).path,"/api/entry/tasks?status=pending");
  assert.deepEqual((await client.list("report")).map(t=>t.id),["b"]);
  assert.equal(calls.at(-1).path,"/api/entry/tasks?status=claimed");
  assert.equal(calls.some(call=>/stats|notifications|export/.test(call.path)),false);
  assert.equal(calls.some(call=>/\/auth\/|\/me$/.test(call.path)),false);
  assert.equal(client.state.actor.verified,false);
});

test("an ambiguous create retry reuses the same request ID; a confirmed new create does not",async()=>{
  const payloads=[];
  const {client}=scenario((path,options)=>{
    payloads.push(JSON.parse(options.body));
    if(payloads.length===1)throw new Error("Connection lost after commit");
    return response({task:{id:"confirmed",status:"pending"}});
  });
  await client.boot();const data={bedNo:"TEST",mrn:"DEMO",patientName:"DEMO",selfReport:false};
  await assert.rejects(()=>client.create(data),/Connection lost/);
  await client.create(data);assert.deepEqual(payloads[0],payloads[1]);
  await client.create(data);assert.notEqual(payloads[1].requestId,payloads[2].requestId);
});

test("changed form data gets a fresh request ID after a failed submission",async()=>{
  const payloads=[];
  const {client}=scenario((path,options)=>{payloads.push(JSON.parse(options.body));throw new Error("network");});
  await client.boot();await assert.rejects(()=>client.create({bedNo:"A"}));await assert.rejects(()=>client.create({bedNo:"B"}));
  assert.notEqual(payloads[0].requestId,payloads[1].requestId);
});

test("a confirmed new case requests LINE notification without exposing clinical fields",async()=>{
  const notices=[];
  const task={id:"9e96fd68-4f7f-4ac2-a6f8-a4c416004490",taskId:"PICC-2610-001",status:"pending"};
  const controlled=createEntryController({adapter:()=>null,uuid:()=>"request-1",fetcher:async path=>{
      if(path==="/api/entry/config")return response({demo:true,loginRequired:false,user:shared,csrf:"test-csrf"});
      if(path==="/api/entry/tasks")return response({task});
      throw new Error("unexpected path "+path);
    },
    notificationFetcher:async(path,options)=>{notices.push({path,options});return response({ok:true,delivered:true});}});
  await controlled.boot();
  await controlled.create({bedNo:"SECRET-BED",mrn:"SECRET-MRN",patientName:"SECRET-NAME",selfReport:false});
  assert.equal(notices.length,1);assert.equal(notices[0].path,"/api/line/notify-task-created");
  assert.deepEqual(JSON.parse(notices[0].options.body),{taskId:task.id});
});

test("claim requires an explicit performer, carries CSRF/version and does not retry a conflict",async()=>{
  const {client,calls}=scenario(()=>response({error:"案件已被其他人更新"},409));
  await client.boot();const count=calls.length;
  await assert.rejects(()=>client.claim({id:"task",version:7},""),/請先選擇/);assert.equal(calls.length,count);
  await assert.rejects(()=>client.claim({id:"task",version:7},"demo-b"),/其他人更新/);
  assert.equal(calls.length,count+1);const call=calls.at(-1);
  assert.equal(call.options.headers.get("X-CSRF-Token"),"test-csrf");
  assert.deepEqual(JSON.parse(call.options.body),{version:7,operatorId:"demo-b"});
});

test("a 200 response without the confirmed target state is not reported as success",async()=>{
  const {client}=scenario(()=>response({task:{id:"task",status:"pending"}}));
  await client.boot();await assert.rejects(()=>client.claim({id:"task",version:1},"demo-b"),/未確認案件結果/);
});

test("completion keeps the actual performer and original task version",async()=>{
  let sent;
  const {client}=scenario((path,options)=>{sent=JSON.parse(options.body);return response({task:{id:"task",status:"completed"}});});
  await client.boot();await client.complete({id:"task",version:3},{operatorId:"demo-b",version:999,remark:"DEMO"});
  assert.equal(sent.version,3);assert.equal(sent.operatorId,"demo-b");assert.equal(sent.remark,"DEMO");
});

test("completion and cancellation request their LINE status notifications after confirmation",async()=>{
  const notices=[];
  const controlled=createEntryController({adapter:()=>null,fetcher:async path=>{
      if(path==="/api/entry/config")return response({demo:true,loginRequired:false,user:shared,csrf:"test-csrf"});
      if(path.endsWith("/complete"))return response({task:{id:"task",status:"completed"}});
      if(path.endsWith("/cancel"))return response({task:{id:"task",status:"cancelled"}});
      throw new Error("unexpected path "+path);
    },notificationFetcher:async(path,options)=>{notices.push({path,body:JSON.parse(options.body)});return response({ok:true,delivered:true});}});
  await controlled.boot();
  await controlled.complete({id:"task",version:1},{operatorId:"demo-b"});
  await controlled.cancel({id:"task",version:2},"病人拒絕","");
  assert.deepEqual(notices,[
    {path:"/api/line/notify-task-status",body:{taskId:"task",event:"completed"}},
    {path:"/api/line/notify-task-status",body:{taskId:"task",event:"cancelled"}},
  ]);
});

test("a status notification retries transient failures and reports delivery on the task",async()=>{
  let attempts=0;
  const controlled=createEntryController({adapter:()=>null,notificationDelay:async()=>{},fetcher:async path=>{
      if(path==="/api/entry/config")return response({demo:true,loginRequired:false,user:shared,csrf:"test-csrf"});
      if(path.endsWith("/complete"))return response({task:{id:"task",status:"completed"}});
      throw new Error("unexpected path "+path);
    },notificationFetcher:async()=>++attempts<3?response({ok:false,delivered:false},503):response({ok:true,delivered:true})});
  await controlled.boot();
  const task=await controlled.complete({id:"task",version:1},{operatorId:"demo-b"});
  assert.equal(attempts,3);assert.equal(task.lineNotificationDelivered,true);
});

test("self-report requires a confirmed completed response and preserves retry identity on an ambiguous result",async()=>{
  const payloads=[];let confirmed=false;
  const {client}=scenario((path,options)=>{payloads.push(JSON.parse(options.body));return response({task:{id:"self-report",status:confirmed?"completed":"pending"}});});
  await client.boot();const values={patientName:"測試甲D",mrn:"00123456",bedNo:"TEST",selfReport:true,operatorId:"demo-b",vein:"其他"};
  await assert.rejects(()=>client.create(values),/未確認案件結果/);
  confirmed=true;assert.equal((await client.create(values)).status,"completed");
  assert.equal(payloads[0].requestId,payloads[1].requestId);
});

test("other cancellation requires text and submits no reopen operation",async()=>{
  const {client,calls}=scenario(()=>response({task:{id:"task",status:"cancelled"}}));
  await client.boot();await assert.rejects(()=>client.cancel({id:"task",version:3},"其他"," "),/補充說明/);
  await client.cancel({id:"task",version:3},"其他","DEMO reason");
  assert.equal(calls.at(-1).path,"/api/entry/tasks/task/cancel");assert.equal(calls.some(call=>call.path.includes("reopen")),false);
});

test("an unavailable entry clears cached context even if the error response is not JSON",async()=>{
  let cleared=0;
  const {client}=scenario(()=>new Response("unavailable",{status:503}),{unavailable:()=>cleared++});
  await client.boot();await assert.rejects(()=>client.list("booking"),/格式不正確/);
  assert.equal(client.state.actor,null);assert.equal(client.state.csrf,"");assert.equal(cleared,1);
});

test("Supabase mode uses the same narrow entry requests and does not fall back to demo HTTP",async()=>{
  const calls=[];
  const adapter={enabled:()=>true,api:()=>{throw new Error("unexpected private API");},entryApi:async path=>{
    calls.push(path);if(path==="/api/config")return {demo:false,loginRequired:false,user:shared};
    return {tasks:[{id:"task",status:"claimed"}]};
  }};
  const client=createEntryController({adapter:()=>adapter,fetcher:()=>{throw new Error("unexpected local HTTP");}});
  await client.boot();assert.equal((await client.list("report")).length,1);
  assert.equal(calls.at(-1),"/api/tasks?status=claimed");assert.equal(client.loginDemo,undefined);assert.equal(client.loginLine,undefined);
});
