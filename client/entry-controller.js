// Workflow-only client for the three mobile entries. The server owns every state change.
export const ENTRY_ROUTES={create:"/picc-create/",booking:"/picc-booking/",report:"/picc-report/"};
export function entryPage(path){
  const normalized=path.replace(/\/+$/,"");
  return Object.keys(ENTRY_ROUTES).find(key=>ENTRY_ROUTES[key].replace(/\/+$/,"")===normalized)||"create";
}
export function createEntryController({fetcher=globalThis.fetch,adapter=()=>globalThis.PiccSupabase,
  notificationFetcher=globalThis.fetch,notificationDelay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  uuid=()=>globalThis.crypto.randomUUID(),onUnavailable=()=>{}}={}){
  const state={config:{},actor:null,csrf:""};
  let draft=null;
  const connected=()=>adapter()?.enabled();
  function context(data){state.actor=data.user;state.csrf=data.csrf||"";return data;}
  function clearContext(){state.actor=null;state.csrf="";draft=null;onUnavailable();}
  async function request(path,options={}){
    try{
      if(connected()){
        if(!adapter().entryApi)throw new Error("共用入口串接程式尚未更新，請重新整理");
        return await adapter().entryApi(path,options);
      }
      const headers=new Headers(options.headers||{});
      if(options.method&&options.method!=="GET")headers.set("X-CSRF-Token",state.csrf);
      let body=options.body;
      if(body!==undefined){headers.set("Content-Type","application/json");body=JSON.stringify(body);}
      const entryPath=path.replace(/^\/api\//,"/api/entry/");
      const response=await fetcher(entryPath,{...options,headers,body,credentials:"same-origin"});
      let data;
      try{data=await response.json();}catch{const error=new Error("伺服器回應格式不正確，請稍後再試");error.status=response.status;throw error;}
      if(!response.ok){const error=new Error(data.error||"操作未完成，請稍後再試");error.status=response.status;throw error;}
      return data;
    }catch(error){
      if(error.status===401||error.status===503)clearContext();
      throw error;
    }
  }
  function requireReady(){if(!state.actor)throw new Error("入口尚未就緒，請重新整理");}
  function updated(data,status=null,id=null){if(!data?.task?.id||(status&&data.task.status!==status)||(id&&data.task.id!==id))throw new Error("伺服器未確認案件結果，請重新整理確認後再試");return data.task;}
  async function notifyCreated(task){
    try{
      await notificationFetcher("/api/line/notify-task-created",{method:"POST",credentials:"same-origin",keepalive:true,
        headers:{"Content-Type":"application/json"},body:JSON.stringify({taskId:task.id})});
    }catch(_error){/* A notification outage must never undo or misreport a committed clinical workflow. */}
  }
  async function notifyStatus(task,event){
    for(let attempt=0;attempt<3;attempt++){
      try{
        const response=await notificationFetcher("/api/line/notify-task-status",{method:"POST",credentials:"same-origin",keepalive:true,
          headers:{"Content-Type":"application/json"},body:JSON.stringify({taskId:task.id,event})});
        const result=await response.json();
        if(response.ok&&result.delivered===true)return true;
      }catch(_error){/* Retry below; a LINE outage must not undo the committed clinical workflow. */}
      if(attempt<2)await notificationDelay(400*(attempt+1));
    }
    return false;
  }
  return {
    state,
    async boot(){
      state.config=await request("/api/config");
      if(state.config.loginRequired!==false||!state.config.user?.id)throw new Error("共用入口尚未完成設定，請重新整理");
      context(state.config);
      return state;
    },
    async members(){requireReady();const data=await request("/api/users");return data.users.filter(member=>Boolean(member.enabled));},
    async list(page){
      requireReady();const status=page==="booking"?"pending":page==="report"?"claimed":null;
      if(!status)throw new Error("此入口不顯示案件清單");
      const statuses=[status];
      const responses=await Promise.all(statuses.map(value=>request("/api/tasks?"+new URLSearchParams({status:value}))));
      const tasks=new Map();
      responses.forEach((data,index)=>{
        if(!Array.isArray(data.tasks))throw new Error("清單回應格式不正確");
        data.tasks.filter(task=>task.status===statuses[index]).forEach(task=>tasks.set(task.id,task));
      });
      return [...tasks.values()];
    },
    async detail(id){requireReady();return request("/api/tasks/"+encodeURIComponent(id));},
    async create(values){
      requireReady();const signature=JSON.stringify(Object.keys(values).sort().map(key=>[key,values[key]]));
      if(!draft||draft.signature!==signature)draft={signature,payload:{...values,requestId:uuid()}};
      const result=await request("/api/tasks",{method:"POST",body:draft.payload});
      if(result?.requiresDuplicateConfirmation){
        const error=new Error("七日內已有相同病歷號案件，請確認是否重複開單。");
        error.duplicateWarning=true;error.duplicateCount=result.duplicateCount;throw error;
      }
      const task=updated(result,values.selfReport?"completed":null);
      draft=null;
      if(!values.selfReport)await notifyCreated(task);
      return task;
    },
    async claim(task,operatorId){
      requireReady();if(!operatorId)throw new Error("請先選擇施打人");
      return updated(await request("/api/tasks/"+encodeURIComponent(task.id)+"/claim",{
        method:"POST",body:{version:task.version,operatorId}}),"claimed",task.id);
    },
    async performed(){throw new Error("請直接使用施打回報，已不再設置待回報階段");},
    async complete(task,values){
      requireReady();const completed=updated(await request("/api/tasks/"+encodeURIComponent(task.id)+"/complete",{
        method:"POST",body:{...values,version:task.version}}),"completed",task.id);
      completed.lineNotificationDelivered=await notifyStatus(completed,"completed");return completed;
    },
    async cancel(task,reason,detail){
      requireReady();if(!reason||(reason==="其他"&&!detail.trim()))throw new Error("請選擇取消原因；選其他時請補充說明");
      const cancelled=updated(await request("/api/tasks/"+encodeURIComponent(task.id)+"/cancel",{
        method:"POST",body:{version:task.version,reason,detail}}),"cancelled",task.id);
      cancelled.lineNotificationDelivered=await notifyStatus(cancelled,"cancelled");return cancelled;
    }
  };
}
