import assert from "node:assert/strict";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
const db=new PGlite();
const A="11111111-1111-4111-8111-111111111111",B="22222222-2222-4222-8222-222222222222",C="33333333-3333-4333-8333-333333333333",X="44444444-4444-4444-8444-444444444444";
const results=[];
async function test(name,fn){try{await fn();results.push({name,passed:true});console.log("PASS",name);}catch(error){results.push({name,passed:false,error:error.message});console.error("FAIL",name,error.message);throw error;}}
await db.exec("create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;");
await db.exec(await readFile(new URL("../supabase/migrations/202610140001_picc_v2.sql",import.meta.url),"utf8"));
await db.query("insert into auth.users values($1),($2),($3),($4)",[A,B,C,X]);
await db.query("insert into picc_v2_private.members(id,auth_user_id,name,role) values($1,$1,'示範管理者','admin'),($2,$2,'示範施打者甲','operator'),($3,$3,'示範施打者乙','operator')",[A,B,C]);
let sequence=0;
async function rpc(uid,action,payload={}){return db.transaction(async tx=>{await tx.exec("set local role authenticated");await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[uid||""]);return(await tx.query("select public.picc_v2_api($1,$2::jsonb) as data",[action,JSON.stringify(payload)])).rows[0].data;});}
const SHARED="00000000-0000-4000-8000-000000000001";
async function entry(action,payload={}){return db.transaction(async tx=>{await tx.exec("set local role anon");await tx.query("select set_config('request.jwt.claim.sub','',true)");return(await tx.query("select public.picc_v2_entry_api($1,$2::jsonb) as data",[action,JSON.stringify(payload)])).rows[0].data;});}
const WORKSPACE="00000000-0000-4000-8000-000000000002";
async function workspace(action,payload={}){return db.transaction(async tx=>{await tx.exec("set local role anon");await tx.query("select set_config('request.jwt.claim.sub','',true)");return(await tx.query("select public.picc_v2_workspace_api($1,$2::jsonb) as data",[action,JSON.stringify(payload)])).rows[0].data;});}
async function entryCreate(extra={}){return(await entry("tasks.create",{patientName:"DEMO shared",bedNo:"TEST",mrn:"DEMO-SHARED",requestId:"entry-"+(++sequence),duplicateAcknowledged:true,...extra})).task;}
async function rejects(uid,action,payload,pattern){await assert.rejects(()=>rpc(uid,action,payload),pattern);}
async function create(extra={}){return(await rpc(A,"tasks.create",{patientName:"DEMO PG",bedNo:"TEST",mrn:"DEMO-PG",requestId:"request-"+(++sequence),duplicateAcknowledged:true,...extra})).task;}
async function claim(t,op=B){return(await rpc(A,"tasks.claim",{id:t.id,version:t.version,operatorId:op})).task;}
const report={operatorId:C,difficulty:"困難",insertionSite:"右上臂",vein:"Basilic",catheterType:"雙腔PICC",catheterLength:40,remark:"PG測試"};
async function complete(t,extra={}){return(await rpc(A,"tasks.complete",{id:t.id,version:t.version,...report,...extra})).task;}
try{
await test("migration is repeatable",async()=>{await db.exec(await readFile(new URL("../supabase/migrations/202610140001_picc_v2.sql",import.meta.url),"utf8"));});
await test("anonymous cannot execute RPC",async()=>{await assert.rejects(()=>db.transaction(async tx=>{await tx.exec("set local role anon");return tx.query("select public.picc_v2_api('tasks.list','{}')");}),/permission denied/);});
await test("unapproved and empty auth IDs are denied",async()=>{await rejects(X,"tasks.list",{},/團隊使用權限/);await rejects(null,"tasks.list",{},/團隊使用權限/);});
await test("authenticated users cannot read or write private tables",async()=>{await assert.rejects(()=>db.transaction(async tx=>{await tx.exec("set local role authenticated");await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[B]);return tx.query("select * from picc_v2_private.tasks");}),/permission denied/);});
await test("every private table enables RLS and accidental select grants still expose no rows",async()=>{const tables=await db.query("select relname,relrowsecurity from pg_class join pg_namespace on pg_namespace.oid=relnamespace where nspname='picc_v2_private' and relkind='r'");assert(tables.rows.every(r=>r.relrowsecurity));await db.transaction(async tx=>{await tx.exec("grant usage on schema picc_v2_private to authenticated; grant select on picc_v2_private.members to authenticated; set local role authenticated;");await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[B]);assert.equal((await tx.query("select * from picc_v2_private.members")).rows.length,0);await tx.exec("reset role; revoke usage on schema picc_v2_private from authenticated; revoke select on picc_v2_private.members from authenticated;");});});
await test("empty list returns an array",async()=>{assert.deepEqual(await rpc(A,"tasks.list"),{tasks:[]});});
await test("quotes and HTML remain plain patient data",async()=>{const t=await create({patientName:"DEMO 'quoted' <img>"});assert.equal(t.patientName,"DEMO 'quoted' <img>");});
await test("idempotency prevents repeat creation and rejects changed payload",async()=>{const p={patientName:"DEMO repeat",bedNo:"TEST",mrn:"DEMO-REPEAT",requestId:"repeat-key"};const a=await rpc(A,"tasks.create",p),b=await rpc(A,"tasks.create",p);assert.equal(a.task.id,b.task.id);assert.equal(b.duplicate,true);await rejects(A,"tasks.create",{...p,patientName:"changed"},/識別碼已使用/);});
await test("only one claim succeeds for the original version",async()=>{const t=await create();await claim(t);await rejects(C,"tasks.claim",{id:t.id,version:t.version,operatorId:C},/其他人更新/);});
await test("volume belongs to actual performer and normal members see only themselves",async()=>{const t=await complete(await claim(await create()));assert.equal(t.operatorId,C);const stats=await rpc(A,"stats");assert.equal(stats.totalCompleted,1);assert.equal(stats.operators[0].operatorId,C);assert.equal((await rpc(B,"stats",{scope:"all"})).totalCompleted,0);assert.equal((await rpc(C,"stats")).totalCompleted,1);});
await test("completed tasks cannot be completed or cancelled again",async()=>{const t=await complete(await claim(await create()));await rejects(A,"tasks.complete",{id:t.id,version:t.version,...report},/只有待預約/);await rejects(A,"tasks.cancel",{id:t.id,version:t.version,reason:"醫囑調整"},/只有新開案或待預約/);});
await test("cancel reason is mandatory and other needs text",async()=>{const t=await create();await rejects(A,"tasks.cancel",{id:t.id,version:t.version},/取消原因/);await rejects(A,"tasks.cancel",{id:t.id,version:t.version,reason:"其他"},/補充說明/);});
await test("reorder retains original cancelled row and cancellation history",async()=>{const t=await create();const c=(await rpc(A,"tasks.cancel",{id:t.id,version:t.version,reason:"醫囑調整",detail:"PG取消測試"})).task;const n=await create({copiedFromTaskId:c.id});assert.equal(n.reorderOf,c.id);assert.notEqual(n.taskId,c.taskId);const old=await rpc(A,"tasks.get",{id:c.id});assert.equal(old.task.status,"cancelled");assert.equal(old.task.cancelReason,"醫囑調整");assert(old.events.some(e=>e.action==="reordered"));assert(old.events.some(e=>e.action==="cancelled"));});
await test("operators cannot edit, remove, export or change members",async()=>{const t=await create();for(const action of["tasks.edit","tasks.remove","tasks.export","users.save"]){await rejects(B,action,{id:t.id,version:t.version},/限管理者/);}});
await test("patient edits preserve completion time and actual performer",async()=>{const t=await complete(await claim(await create()));const e=(await rpc(A,"tasks.edit",{id:t.id,version:t.version,patientName:"DEMO edit",bedNo:"NEW",mrn:t.mrn,remark:"edited"})).task;assert.equal(e.completedAt,t.completedAt);assert.equal(e.operatorId,t.operatorId);});
await test("Taiwan dates control period statistics",async()=>{const t=await complete(await claim(await create()));await db.query("update picc_v2_private.tasks set completed_at='2030-01-01T16:30:00Z' where id=$1",[t.id]);assert.equal((await rpc(A,"stats",{start:"2030-01-02",end:"2030-01-02"})).totalCompleted,1);assert.equal((await rpc(A,"stats",{start:"2030-01-01",end:"2030-01-01"})).totalCompleted,0);});
await test("rename does not split performer totals",async()=>{await rpc(A,"users.save",{id:C,authUserId:C,name:"更名施打者乙",role:"operator",enabled:true});await complete(await claim(await create()));const stats=await rpc(A,"stats");assert.equal(stats.operators.length,1);assert.equal(stats.operators[0].operatorName,"更名施打者乙");});
await test("legacy import preserves unknown completion date and skips duplicates",async()=>{const rows=[{"起單時間":"2026/10/01 10:00","任務編號":"OLD-PG-001","病人姓名":"DEMO legacy","床號":"TEST","病歷號":"LEGACY","Status":"完成","施打者":"更名施打者乙","備註":"PG舊資料"}];const result=await rpc(A,"tasks.import",{rows});assert.equal(result.missingCompletionDate,1);assert.equal((await rpc(A,"tasks.import",{rows})).skipped,1);assert.equal((await rpc(A,"stats")).missingCompletionDate,1);});
await test("invalid import rolls back the entire batch",async()=>{const row={"起單時間":"2026/10/01 10:00","任務編號":"ROLLBACK-PG-1","病人姓名":"DEMO","床號":"TEST","病歷號":"ROLLBACK","Status":"待預約"};await rejects(A,"tasks.import",{rows:[row,{...row,"任務編號":"ROLLBACK-PG-2","Status":"unknown"}]},/狀態無法辨識/);assert.equal((await rpc(A,"tasks.list",{q:"ROLLBACK-PG"})).tasks.length,0);});
await test("bad date range is rejected",async()=>{await rejects(A,"stats",{start:"2026-10-02",end:"2026-10-01"},/開始日期/);});
await test("disabled members lose access immediately",async()=>{await db.query("update picc_v2_private.members set enabled=false where id=$1",[B]);await rejects(B,"tasks.list",{},/團隊使用權限/);});
await test("LINE notifications stay deferred",async()=>{assert.equal((await rpc(A,"notifications.list")).deferred,true);assert.equal((await rpc(A,"announce")).deferred,true);});
await test("shared entry starts without a personal identity or new Auth account",async()=>{const info=await entry("entry.info");assert.equal(info.loginRequired,false);assert.equal(info.user.id,SHARED);assert.equal(info.user.verified,false);assert.equal((await db.query("select count(*)::int as n from auth.users")).rows[0].n,4);});
await test("shared entry roster excludes the shared actor and private Auth identifiers",async()=>{const roster=(await entry("users.list")).users;assert(!roster.some(row=>row.id===SHARED));assert(roster.every(row=>!('auth_user_id' in row)&&!('line_id' in row)));});
await test("shared creation is audited as shared and retry remains idempotent",async()=>{const payload={patientName:"DEMO entry retry",bedNo:"TEST",mrn:"DEMO-ENTRY-RETRY",requestId:"shared-retry"};const first=await entry("tasks.create",payload),second=await entry("tasks.create",payload);assert.equal(first.task.id,second.task.id);assert.equal(second.duplicate,true);assert.equal(first.task.createdBy,SHARED);const audit=await entry("tasks.get",{id:first.task.id});assert(audit.events.every(row=>row.actorName==='內部共用入口（未驗證操作者）'));});
await test("shared completion still counts the selected actual performer",async()=>{let t=await entryCreate();t=(await entry("tasks.claim",{id:t.id,version:t.version,operatorId:A})).task;const previous=(await rpc(A,"stats")).totalCompleted;t=(await entry("tasks.complete",{id:t.id,version:t.version,...report})).task;assert.equal(t.operatorId,C);assert.equal((await rpc(A,"stats")).totalCompleted,previous+1);});
await test("the shared actor cannot be selected as a clinical performer",async()=>{let t=await entryCreate();await assert.rejects(()=>entry("tasks.claim",{id:t.id,version:t.version,operatorId:SHARED}),/有效的預約施打者/);await assert.rejects(()=>entryCreate({...report,operatorId:SHARED,selfReport:true}),/有效的實際施打者/);t=(await entry("tasks.claim",{id:t.id,version:t.version,operatorId:C})).task;await assert.rejects(()=>entry("tasks.complete",{id:t.id,version:t.version,...report,operatorId:SHARED}),/有效的實際施打者/);});
await test("shared cancellation and reorder preserve the old cancelled record",async()=>{let t=await entryCreate();t=(await entry("tasks.cancel",{id:t.id,version:t.version,reason:"其他",detail:"DEMO shared cancellation"})).task;const next=await entryCreate({copiedFromTaskId:t.id});assert.equal(next.reorderOf,t.id);assert.equal((await entry("tasks.get",{id:t.id})).task.status,"cancelled");});
await test("shared lists require an explicit pending or claimed status",async()=>{for(const status of ["completed","cancelled",""])await assert.rejects(()=>entry("tasks.list",{status}),/請指定新開案/);const list=await entry("tasks.list",{status:"pending"});assert(list.tasks.every(row=>row.status==='pending'));});
await test("shared entry cannot call administration, statistics, imports or notifications",async()=>{for(const action of ["stats","users.save","tasks.edit","tasks.remove","tasks.export","tasks.import","announce","notifications.list"])await assert.rejects(()=>entry(action,{}),/只提供建案/);});
await test("anonymous shared access does not grant direct table or private-engine access",async()=>{await assert.rejects(()=>db.transaction(async tx=>{await tx.exec("set local role anon");return tx.query("select * from picc_v2_private.tasks");}),/permission denied/);await assert.rejects(()=>db.transaction(async tx=>{await tx.exec("set local role anon");return tx.query("select picc_v2_private.api_as(null,'stats','{}')");}),/permission denied/);});
await test("member administration cannot promote or reassign the shared audit actor",async()=>{await rejects(A,"users.save",{id:SHARED,name:"Changed",role:"admin",enabled:true},/共用入口不是施打成員/);});
await test("disabling the shared actor immediately closes the shared API",async()=>{await db.query("update picc_v2_private.members set enabled=false where id=$1",[SHARED]);try{await assert.rejects(()=>entry("entry.info"),/共用入口目前無法使用/);}finally{await db.query("update picc_v2_private.members set enabled=true where id=$1",[SHARED]);}});
await test("desktop workspace opens fully without a personal identity",async()=>{const info=await workspace("workspace.info");assert.equal(info.loginRequired,false);assert.equal(info.sharedWorkspace,true);assert.equal(info.user.id,WORKSPACE);assert.equal(info.user.verified,false);assert.equal(info.user.role,"admin");});
await test("desktop workspace supports cases, statistics and performer roster",async()=>{assert(Array.isArray((await workspace("tasks.list")).tasks));assert.equal(typeof(await workspace("stats")).totalCompleted,"number");const users=(await workspace("users.list")).users;assert(!users.some(user=>[SHARED,WORKSPACE].includes(user.id)));assert(users.every(user=>!("auth_user_id" in user)&&!("line_id" in user)));});
await test("desktop case edits retain a shared workspace audit identity",async()=>{let t=(await workspace("tasks.create",{patientName:"DEMO desk",bedNo:"TEST",mrn:"DEMO-DESK",requestId:"workspace-case"})).task;assert.equal(t.createdBy,WORKSPACE);t=(await workspace("tasks.edit",{id:t.id,version:t.version,patientName:t.patientName,bedNo:t.bedNo,mrn:t.mrn,remark:"DEMO edit"})).task;const result=await workspace("tasks.get",{id:t.id});assert.equal(t.remark,"DEMO edit");assert(result.events.every(e=>e.actorName==='內部共用工作站（未驗證操作者）'));});
await test("workspace roster changes cannot grant personal Auth privileges",async()=>{const id="55555555-5555-4555-8555-555555555555";await workspace("users.save",{id,name:"DEMO roster",role:"admin",authUserId:X,enabled:true});const row=(await db.query("select role,auth_user_id from picc_v2_private.members where id=$1",[id])).rows[0];assert.equal(row.role,"operator");assert.equal(row.auth_user_id,null);});
await test("workspace roster rename preserves existing personal account links",async()=>{await workspace("users.save",{id:C,name:"DEMO renamed roster",role:"operator",enabled:true});assert.equal((await db.query("select auth_user_id from picc_v2_private.members where id=$1",[C])).rows[0].auth_user_id,C);});
await test("desktop shared actor cannot be counted as a clinical performer",async()=>{const t=await entryCreate();await assert.rejects(()=>workspace("tasks.claim",{id:t.id,version:t.version,operatorId:WORKSPACE}),/有效的預約施打者/);await assert.rejects(()=>workspace("users.save",{id:WORKSPACE,name:"Changed",role:"operator",enabled:false}),/共用入口不是施打成員/);});
await test("desktop workspace does not enable LINE announcements or arbitrary functions",async()=>{for(const action of["announce","auth.login","pg_read_file"])await assert.rejects(()=>workspace(action,{}),/工作站不支援此操作/);});
await test("disabling the desktop actor closes the full workspace without changing phone access",async()=>{await db.query("update picc_v2_private.members set enabled=false where id=$1",[WORKSPACE]);try{await assert.rejects(()=>workspace("workspace.info"),/共用工作站目前無法使用/);assert.equal((await entry("entry.info")).loginRequired,false);}finally{await db.query("update picc_v2_private.members set enabled=true where id=$1",[WORKSPACE]);}});
await test("awaiting report survives migration, preserves audit and does not count until report completion",async()=>{
  let t=await claim(await create({mrn:"DEMO-AWAITING-V3"}),C);const before=(await rpc(A,"stats")).totalCompleted;
  const stale=t.version;t=(await entry("tasks.performed",{id:t.id,version:t.version})).task;
  assert.equal(t.status,"awaiting_report");assert.equal(t.statusLabel,"施打回報");assert.equal((await rpc(A,"stats")).totalCompleted,before);
  await assert.rejects(()=>entry("tasks.performed",{id:t.id,version:stale}),/其他人更新/);
  await db.exec(await readFile(new URL("../supabase/migrations/202610140001_picc_v2.sql",import.meta.url),"utf8"));
  assert.equal((await entry("tasks.get",{id:t.id})).task.status,"awaiting_report");
  assert((await entry("tasks.list",{status:"awaiting_report"})).tasks.some(x=>x.id===t.id));
  assert((await entry("tasks.get",{id:t.id})).events.some(e=>e.action==="awaiting_report"));
  await assert.rejects(()=>entry("tasks.cancel",{id:t.id,version:t.version,reason:"醫囑調整"}),/只有新開案或待預約/);
  t=(await entry("tasks.complete",{id:t.id,version:t.version,...report,insertionSite:"左下肢"})).task;
  assert.equal(t.insertionSite,"左下肢");assert.equal((await rpc(A,"stats")).totalCompleted,before+1);
});
await test("right lower limb is accepted by the real report validator",async()=>{
  const t=await claim(await create({mrn:"DEMO-RIGHT-LEG-V3"}),C);
  assert.equal((await rpc(A,"tasks.complete",{id:t.id,version:t.version,...report,insertionSite:"右下肢"})).task.insertionSite,"右下肢");
});
await test("seven-day duplicate warning is shared across actors, does not create a row and permits acknowledged idempotent submission",async()=>{
  await create({mrn:"DEMO-DUPLICATE-V3"});
  const payload={patientName:"DEMO duplicate",bedNo:"TEST",mrn:" DEMO-DUPLICATE-V3 ",requestId:"warn-v3"};
  const warning=await entry("tasks.create",payload);assert.equal(warning.requiresDuplicateConfirmation,true);assert.equal(warning.duplicateCount,1);assert.equal(warning.task,undefined);
  assert.equal((await rpc(A,"tasks.list",{q:"DEMO-DUPLICATE-V3"})).tasks.length,1);
  const accepted=await entry("tasks.create",{...payload,duplicateAcknowledged:true});
  assert.equal(accepted.task.status,"pending");
  const retry=await entry("tasks.create",{...payload,duplicateAcknowledged:true});assert.equal(retry.task.id,accepted.task.id);assert.equal(retry.duplicate,true);
  assert.equal((await rpc(A,"tasks.list",{q:"DEMO-DUPLICATE-V3"})).tasks.length,2);
});
await test("duplicate check ignores cases older than seven days and removed test cases",async()=>{
  const old=await create({mrn:"DEMO-OLD-V3"});await db.query("update picc_v2_private.tasks set created_at=now()-interval '8 days' where id=$1",[old.id]);
  assert((await entry("tasks.create",{patientName:"DEMO old",bedNo:"TEST",mrn:old.mrn,requestId:"old-v3"})).task);
  const removed=await create({mrn:"DEMO-REMOVED-V3"});await rpc(A,"tasks.remove",{id:removed.id,version:removed.version,reason:"Synthetic cleanup"});
  assert((await entry("tasks.create",{patientName:"DEMO removed",bedNo:"TEST",mrn:removed.mrn,requestId:"removed-v3"})).task);
});
await test("monthly case numbers follow Taiwan month boundaries and never truncate after 999",async()=>{
  const next=async stamp=>(await db.query("select picc_v2_private.next_case_number($1::timestamptz) as number",[stamp])).rows[0].number;
  assert.equal(await next('2098-12-31T15:59:00Z'),'PICC-9812-001');
  assert.equal(await next('2098-12-31T16:00:00Z'),'PICC-9901-001');
  assert.equal(await next('2098-12-31T16:01:00Z'),'PICC-9901-002');
  await db.query("insert into picc_v2_private.case_counters(period,last_value) values('9802',999)");
  assert.equal(await next('2098-02-01T00:00:00Z'),'PICC-9802-1000');
});
await test("warnings and idempotent retries do not consume a case number; failed transactions roll numbering back",async()=>{
  const original=await create({mrn:'CASE-COUNTER-RETRY'});
  const before=(await db.query('select sum(last_value)::int as n from picc_v2_private.case_counters')).rows[0].n;
  assert.equal((await entry('tasks.create',{patientName:'DEMO warning',bedNo:'TEST',mrn:original.mrn,requestId:'counter-warning'})).requiresDuplicateConfirmation,true);
  assert.equal((await db.query('select sum(last_value)::int as n from picc_v2_private.case_counters')).rows[0].n,before);
  const payload={patientName:'DEMO retry',bedNo:'TEST',mrn:'CASE-COUNTER-NEW',requestId:'counter-new'};
  const first=await entry('tasks.create',payload),second=await entry('tasks.create',payload);assert.equal(first.task.taskId,second.task.taskId);
  let rolledBackNumber;
  await assert.rejects(()=>db.transaction(async tx=>{
    const result=await tx.query("select public.picc_v2_workspace_api('tasks.create',$1::jsonb) as result",[JSON.stringify({patientName:'DEMO rollback',bedNo:'TEST',mrn:'CASE-COUNTER-ROLLBACK',requestId:'counter-rollback'})]);
    rolledBackNumber=result.rows[0].result.task.taskId;throw new Error('intentional rollback');
  }),/intentional rollback/);
  assert.equal((await create({mrn:'CASE-COUNTER-AFTER'})).taskId,rolledBackNumber);
});
await test("new CSV state codes and legacy labels retain distinct booking meanings",async()=>{
  const base={"起單時間":"2026/10/01 10:00","病人姓名":"DEMO import","床號":"TEST","病歷號":"CSV-V4","Status":"待預約"};
  await workspace('tasks.import',{rows:[{...base,"任務編號":"CSV-V4-OLD"},{...base,"任務編號":"CSV-V4-NEW","狀態代碼":"claimed"}]});
  const rows=(await workspace('tasks.list',{q:'CSV-V4'})).tasks;
  assert.equal(rows.find(t=>t.taskId==='CSV-V4-OLD').status,'pending');
  assert.equal(rows.find(t=>t.taskId==='CSV-V4-NEW').status,'claimed');
  await assert.rejects(()=>workspace('tasks.import',{rows:[{...base,"任務編號":"CSV-V4-BAD","狀態代碼":"invalid"}]}),/狀態無法辨識/);
});
await test("anonymous users cannot consume the private monthly counter",async()=>{
  await assert.rejects(()=>db.transaction(async tx=>{await tx.exec('set local role anon');return tx.query('select picc_v2_private.next_case_number(now())');}),/permission denied/);
});
console.log("Supabase SQL:",results.length,"passed");
}catch(error){process.exitCode=1;console.error(error.stack);}
finally{await mkdir(new URL("../verification/",import.meta.url),{recursive:true});await writeFile(new URL("../verification/supabase-tests.json",import.meta.url),JSON.stringify({engine:"PGlite PostgreSQL",passed:results.filter(r=>r.passed).length,total:results.length,scope:"SQL and role behavior locally; not remote Supabase, not native multi-connection load testing",results},null,2));await db.close();}
