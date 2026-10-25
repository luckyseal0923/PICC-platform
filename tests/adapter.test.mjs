import assert from "node:assert/strict";
import {createAdapter,parseCSV,isSharedEntryPath} from "../client/supabase-adapter.js";
const calls=[];
const client={
  rpc:async(name,args)=>{calls.push({name,...args});return{data:args,error:null};},
  auth:{getUser:async()=>({data:{user:{id:"test"}},error:null}),signOut:async()=>({error:null})}
};
const adapter=createAdapter(client,{supabaseUrl:"https://example.test",authProvider:"",testAuthEnabled:true});
await adapter.api("/api/tasks/uuid/claim",{method:"POST",body:{version:1,operatorId:"operator"}});
assert.equal(calls.at(-1).p_action,"tasks.claim");assert.equal(calls.at(-1).p_payload.id,"uuid");
await adapter.api("/api/tasks?mine=1&q=DEMO");
assert.equal(calls.at(-1).p_payload.mine,true);assert.equal(calls.at(-1).p_payload.q,"DEMO");
await adapter.api("/api/users",{method:"POST",body:{authUserId:"auth-user",name:"DEMO"}});
assert.equal(calls.at(-1).p_action,"users.save");assert.equal(calls.at(-1).p_payload.authUserId,"auth-user");
await adapter.api("/api/export?start=2026-10-01");
assert.equal(calls.at(-1).p_action,"tasks.export");
assert.equal((await adapter.api("/api/config")).backend,"supabase");
assert.equal((await adapter.api("/api/config")).notificationsEnabled,false);
await assert.rejects(()=>adapter.api("/api/announce"),/下一階段/);
const csv='\ufeff起單時間,任務編號,病人姓名,床號,病歷號,Status,備註\r\n2026/10/01 10:00,OLD,DEMO,TEST,DEMO,完成,"a,b\nquoted ""text"""\r\n';
const rows=parseCSV(csv);assert.equal(rows.length,1);assert.equal(rows[0]["備註"],'a,b\nquoted "text"');
assert.throws(()=>parseCSV('x,x\n1,2'),/欄位名稱重複/);
assert.throws(()=>parseCSV('起單時間,任務編號,病人姓名,床號,病歷號,Status\n"unterminated'),/引號未結束/);
const errorAdapter=createAdapter({...client,rpc:async()=>({data:null,error:{code:"42501",message:"此功能限管理者使用"}})},{});
await assert.rejects(()=>errorAdapter.api("/api/export"),/限管理者/);
console.log("Frontend adapter: route mapping, auth mode, CSV quoting, deferred LINE and authorization errors passed.");
const oauthCalls=[];
const configured=createAdapter({...client,auth:{...client.auth,signInWithOAuth:async args=>{oauthCalls.push(args);return {error:null};}}},{authProvider:"configured-provider"},"https://picc.test");
for(const path of ["/","/workspace/","/picc-create/","/picc-booking/","/picc-report/"]){await configured.signInWithLine(path);assert.equal(oauthCalls.at(-1).options.redirectTo,"https://picc.test"+path);}
const oauthCount=oauthCalls.length;
for(const path of ["https://foreign.test/","/picc-create/?mrn=DEMO","/picc-report/#task","/admin/"])await assert.rejects(()=>configured.signInWithLine(path),/返回網址不正確/);
assert.equal(oauthCalls.length,oauthCount);
console.log("Auth return paths: dashboard and three mobile entries passed; external, arbitrary and data-bearing redirects rejected.");
const sharedCalls=[];
const publicClient={rpc:async(name,args)=>{sharedCalls.push({name,...args});return {data:args.p_action==="entry.info"?{loginRequired:false,user:{id:"shared",verified:false}}:{tasks:[]},error:null};}};
const sharedAdapter=createAdapter({rpc:()=>{throw new Error("private client must not be used");},auth:{getUser:()=>{throw new Error("personal identity must not be checked");}}},{},"https://picc.test",publicClient);
assert.equal((await sharedAdapter.entryApi("/api/config")).loginRequired,false);
await sharedAdapter.entryApi("/api/tasks?status=pending");
assert.equal(sharedCalls.at(-1).name,"picc_v2_entry_api");assert.equal(sharedCalls.at(-1).p_payload.status,"pending");
for(const path of ["/api/me","/api/stats","/api/export","/api/auth/demo"])await assert.rejects(()=>sharedAdapter.entryApi(path),/只提供建案/);
await assert.rejects(()=>sharedAdapter.entryApi("/api/users",{method:"POST",body:{}}),/只提供建案/);
for(const path of ["/picc-create/","/picc-booking","/picc-report/","/assets/mobile-preview.html"])assert.equal(isSharedEntryPath(path),true);
assert.equal(isSharedEntryPath("/"),true);assert.equal(isSharedEntryPath("/workspace/"),true);
await sharedAdapter.workspaceApi("/api/config");assert.equal(sharedCalls.at(-1).name,"picc_v2_workspace_api");assert.equal(sharedCalls.at(-1).p_action,"workspace.info");
await sharedAdapter.workspaceApi("/api/stats");assert.equal(sharedCalls.at(-1).p_action,"stats");
await sharedAdapter.workspaceApi("/api/users",{method:"POST",body:{name:"DEMO",role:"operator"}});assert.equal(sharedCalls.at(-1).p_action,"users.save");
await assert.rejects(()=>sharedAdapter.workspaceApi("/api/auth/demo"),/不支援此操作/);
console.log("Shared entry adapter: no personal auth, separate public client/RPC, and no admin operations passed.");
