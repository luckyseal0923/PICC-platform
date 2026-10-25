import {createClient} from "@supabase/supabase-js";

export const enums={
  cancelReasons:["暫不需要施打","醫囑調整","病人因素","等待時間過久","其他"],
  difficulties:["非常簡單","簡單","中等","困難","非常困難"],
  sites:["右上臂","左上臂","左下肢","右下肢","其他"],veins:["Basilic","Cephalic","Brachial"],catheters:["雙腔PICC","單腔PICC"]
};

export function parseCSV(input){
  const source=input.replace(/^\uFEFF/,""),rows=[];let row=[],cell="",quoted=false;
  for(let i=0;i<source.length;i++){
    const c=source[i];
    if(c==='"'){
      if(quoted && source[i+1]==='"'){cell+='"';i++;}
      else if(quoted)quoted=false;
      else if(cell==="")quoted=true;
      else throw new Error("CSV 引號格式不正確");
    }else if(c===","&&!quoted){row.push(cell);cell="";}
    else if((c==="\n"||c==="\r")&&!quoted){
      if(c==="\r"&&source[i+1]==="\n")i++;
      row.push(cell);if(row.some(x=>x!==""))rows.push(row);row=[];cell="";
    }else cell+=c;
  }
  if(quoted)throw new Error("CSV 引號未結束");
  if(cell!==""||row.length){row.push(cell);if(row.some(x=>x!==""))rows.push(row);}
  if(!rows.length)throw new Error("CSV 沒有資料");
  const headers=rows.shift();if(new Set(headers).size!==headers.length)throw new Error("CSV 欄位名稱重複");
  const required=["起單時間","任務編號","病人姓名","床號","病歷號","Status"];
  if(required.some(h=>!headers.includes(h)))throw new Error("CSV 缺少舊版案件的必要欄位");
  return rows.map((values,index)=>{if(values.length!==headers.length)throw new Error("第 "+(index+2)+" 列欄位數不正確");return Object.fromEntries(headers.map((h,i)=>[h,values[i]]));});
}

export function isSharedEntryPath(path){return path==="/"||/^\/workspace\/?$/.test(path)||/^\/picc-(create|booking|report)(\/|$)/.test(path)||path==="/assets/mobile-preview.html";}
export function createAdapter(client,config,base="http://localhost",entryClient=client){
  async function rpc(action,payload={},shared=false){
    const name=shared==="workspace"?"picc_v2_workspace_api":shared?"picc_v2_entry_api":"picc_v2_api";
    const {data,error}=await (shared?entryClient:client).rpc(name,{p_action:action,p_payload:payload});
    if(error){
      if(error.code==="PGRST202")throw new Error("系統尚未完成啟用，請聯絡管理者。");
      if(error.code==="22P02")throw new Error("資料格式不正確，請確認後再試");
      if(error.code==="23514"||error.code==="23502")throw new Error("請檢查必填欄位與資料長度");
      if(error.code==="23503")throw new Error("登入使用者 ID 不存在，請確認成員的 Supabase 帳號");
      if(error.code==="23505")throw new Error("此帳號或任務編號已存在");
      throw new Error(error.message||"操作未完成，請稍後再試");
    }
    return data;
  }
  async function getMe(){
    const {data,error}=await client.auth.getUser();
    if(error||!data?.user)throw new Error("請先登入");
    return rpc("me");
  }
  return {
    enabled:()=>true,
    async workspaceApi(path,options={}){
      const url=new URL(path,base),method=options.method||"GET",payload={...Object.fromEntries(url.searchParams),...(options.body instanceof FormData?{}:options.body||{})};
      const workspaceRpc=(action,body=payload)=>rpc(action,body,"workspace");
      if(url.pathname==="/api/config")return {demo:false,trialMode:Boolean(config.trialMode),backend:"supabase",appName:"picc-v2",notificationsEnabled:false,...enums,...await workspaceRpc("workspace.info",{})};
      if(url.pathname==="/api/users")return workspaceRpc(method==="GET"?"users.list":"users.save");
      if(url.pathname==="/api/stats")return workspaceRpc("stats");
      if(url.pathname==="/api/export")return workspaceRpc("tasks.export");
      if(url.pathname==="/api/import"){
        const file=options.body.get("file");if(!file||file.size>2*1024*1024)throw new Error("請選擇 2 MB 以下的 UTF-8 CSV");
        return workspaceRpc("tasks.import",{rows:parseCSV(await file.text())});
      }
      if(url.pathname==="/api/notifications")return workspaceRpc("notifications.list",{});
      if(url.pathname==="/api/tasks")return workspaceRpc(method==="GET"?"tasks.list":"tasks.create");
      const match=url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(claim|performed|complete|cancel))?$/);
      if(match){payload.id=decodeURIComponent(match[1]);return workspaceRpc("tasks."+(match[2]||(method==="GET"?"get":method==="PUT"?"edit":method==="DELETE"?"remove":"unsupported")));}
      throw new Error("工作站不支援此操作");
    },
    async entryApi(path,options={}){
      const url=new URL(path,base),method=options.method||"GET",payload={...Object.fromEntries(url.searchParams),...(options.body||{})};
      if(url.pathname==="/api/config")return {demo:false,trialMode:Boolean(config.trialMode),backend:"supabase",appName:"picc-v2",notificationsEnabled:false,...enums,...await rpc("entry.info",{},true)};
      if(url.pathname==="/api/users"&&method==="GET")return rpc("users.list",{},true);
      if(url.pathname==="/api/tasks"&&["GET","POST"].includes(method))return rpc(method==="GET"?"tasks.list":"tasks.create",payload,true);
      const match=url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(claim|performed|complete|cancel))?$/);
      if(match&&((method==="GET"&&!match[2])||(method==="POST"&&match[2]))){
        payload.id=decodeURIComponent(match[1]);return rpc("tasks."+(match[2]||"get"),payload,true);
      }
      throw new Error("共用入口只提供建案、預約與回報操作");
    },
    async signInWithPassword(email,password){
      const {error}=await client.auth.signInWithPassword({email,password});
      if(error)throw new Error("登入未完成，請確認帳號與密碼");
      return getMe();
    },
    async signInWithLine(returnPath="/workspace/"){
      if(!config.authProvider)throw new Error("LINE 登入尚未完成設定");
      const target=new URL(returnPath,base);
      const allowed=["/","/workspace/","/picc-create/","/picc-booking/","/picc-report/"];
      if(target.origin!==new URL(base).origin||!allowed.includes(target.pathname)||target.search||target.hash)throw new Error("登入返回網址不正確");
      const {error}=await client.auth.signInWithOAuth({provider:config.authProvider,options:{redirectTo:target.href}});
      if(error)throw new Error("LINE 登入尚未完成，請稍後再試");
    },
    async api(path,options={}){
      const url=new URL(path,base),method=options.method||"GET",payload={...Object.fromEntries(url.searchParams),...(options.body||{})};
      if(payload.mine!==undefined)payload.mine=payload.mine==="1"||payload.mine===true;
      if(url.pathname==="/api/config")return {demo:false,backend:"supabase",appName:"picc-v2",lineReady:Boolean(config.authProvider),liffId:"",testAuthEnabled:Boolean(config.testAuthEnabled),notificationsEnabled:false,...enums};
      if(url.pathname==="/api/me")return getMe();
      if(url.pathname==="/api/auth/logout"){const {error}=await client.auth.signOut();if(error)throw new Error("登出未完成");return {ok:true};}
      if(url.pathname==="/api/users")return rpc(method==="GET"?"users.list":"users.save",payload);
      if(url.pathname==="/api/stats")return rpc("stats",payload);
      if(url.pathname==="/api/export")return rpc("tasks.export",payload);
      if(url.pathname==="/api/import"){
        const file=options.body.get("file");if(!file||file.size>2*1024*1024)throw new Error("請選擇 2 MB 以下的 UTF-8 CSV");
        return rpc("tasks.import",{rows:parseCSV(await file.text())});
      }
      if(url.pathname==="/api/notifications")return rpc("notifications.list");
      if(url.pathname==="/api/announce")throw new Error("LINE 通知保留於下一階段串接");
      if(url.pathname==="/api/tasks")return rpc(method==="GET"?"tasks.list":"tasks.create",payload);
      const match=url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(claim|performed|complete|cancel))?$/);
      if(match){
        payload.id=decodeURIComponent(match[1]);
        const action=match[2]|| (method==="GET"?"get":method==="PUT"?"edit":method==="DELETE"?"remove":null);
        if(!action)throw new Error("不支援此操作");
        return rpc("tasks."+action,payload);
      }
      throw new Error("不支援此操作");
    }
  };
}
const config=typeof window!=="undefined"?(window.PICC_CONFIG||{}):{};
function rejectPrivilegedKey(key){
  if(key.startsWith("sb_secret_"))throw new Error("前端不可使用 Supabase secret key");
  if(key.split(".").length===3){
    try{
      const payload=JSON.parse(atob(key.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));
      if(payload.role==="service_role")throw new Error("前端不可使用 Supabase service-role key");
    }catch(error){if(error.message.includes("service-role"))throw error;}
  }
}
if(typeof window!=="undefined"){
  window.PiccSupabase={enabled:()=>false};
  if(config.setupError){
    const fail=async()=>{throw new Error(config.setupError);};
    window.PiccSupabase={enabled:()=>true,api:fail,entryApi:fail,workspaceApi:fail};
  }else if(config.supabaseUrl&&config.supabaseAnonKey){
    try{
      rejectPrivilegedKey(config.supabaseAnonKey);
      const url=new URL(config.supabaseUrl);
      if(url.protocol!=="https:"&&!["localhost","127.0.0.1"].includes(url.hostname))throw new Error("Supabase API 請使用 HTTPS");
      const entryClient=createClient(config.supabaseUrl,config.supabaseAnonKey,{
        auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,storageKey:"picc-v2-shared-entry"}
      });
      const client=isSharedEntryPath(window.location.pathname)?entryClient:createClient(config.supabaseUrl,config.supabaseAnonKey,{
        auth:{flowType:"pkce",persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storageKey:"picc-v2-auth"}
      });
      window.PiccSupabase=createAdapter(client,config,window.location.origin,entryClient);
    }catch(error){
      window.PiccSupabase={enabled:()=>true,api:async()=>{throw error;},entryApi:async()=>{throw error;},workspaceApi:async()=>{throw error;}};
    }
  }
}
