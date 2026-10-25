import {ENTRY_ROUTES,entryPage,createEntryController} from "./entry-controller.js";

const $=selector=>document.querySelector(selector);
const escape=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const page=entryPage(location.pathname);
const info={create:["PICC 任務建立","填寫病人資料，建立一筆待預約案件。"],booking:["PICC 待預約清單","以下案件尚未被接單，請選擇施打人後點選「預約施打」。"],report:["PICC 待施打清單","僅顯示已接單、等待施打的案件，點選後填寫施打回報。"]};
const state={members:[],tasks:[],selfReport:false,draft:{},original:null,activeTask:null,busy:false,initialTaskOpened:false,loadVersion:0};
const dateFormat=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"});
const client=createEntryController({onUnavailable:()=>{
  state.members=[];state.tasks=[];state.activeTask=null;state.original=null;state.draft={};
  state.selfReport=false;state.initialTaskOpened=false;state.loadVersion++;
  $("#entryContent").innerHTML="";$("#entryContent").hidden=true;
  $("#pageMessage").hidden=true;if($("#entryDialog").open)$("#entryDialog").close();
}});
document.body.dataset.page=page;document.title=info[page][0];
$("#pageTitle").textContent=info[page][0];$("#pageDescription").textContent=info[page][1];

function message(text,error=false,extra=""){
  const box=$("#pageMessage");box.classList.toggle("error",error);box.hidden=false;
  box.innerHTML='<p>'+escape(text)+'</p>'+extra;box.tabIndex=-1;box.focus();
}
function options(values,current="",placeholder="請選擇"){
  return '<option value="">'+escape(placeholder)+'</option>'+values.map(value=>'<option value="'+escape(value)+'"'+(value===current?' selected':'')+'>'+escape(value)+'</option>').join("");
}
function memberOptions(current="",placeholder="請選擇施打人"){
  return '<option value="">'+escape(placeholder)+'</option>'+state.members.map(member=>'<option value="'+escape(member.id)+'"'+(member.id===current?' selected':'')+'>'+escape(member.name)+'</option>').join("");
}
function reportFields(values={},task=null){
  const config=client.state.config,operator=values.operatorId||task?.operatorId||task?.claimedId||"";
  const select=(label,name,choices)=>'<label for="'+name+'">'+label+' *</label><select id="'+name+'" name="'+name+'" required>'+options(choices,values[name]||"")+'</select>';
  return '<fieldset class="report-fields"><legend>施打紀錄</legend><label for="operatorId">實際施打者 *</label><select id="operatorId" name="operatorId" required>'+memberOptions(operator,"請選擇實際施打者")+'</select><p class="help">施打量依實際施打者與完成日期計算。</p>'+
    select("放置困難度","difficulty",config.difficulties)+select("施打位置","insertionSite",config.sites)+
    select("血管","vein",config.veins)+select("管路類型","catheterType",config.catheters)+
    '<label for="catheterLength">管路長度（cm，選填）</label><input id="catheterLength" name="catheterLength" type="number" min="0.01" step="any" inputmode="decimal" value="'+escape(values.catheterLength||"")+'"></fieldset>';
}
function notes(value="",expanded=false){
  return '<details class="optional-note"'+(expanded||value?' open':'')+'><summary>備註（選填）</summary><label class="help" for="remark">補充施打或交接資訊</label><textarea name="remark" id="remark" maxlength="1000">'+escape(value)+'</textarea></details>';
}
function patientSummary(task){
  return '<div class="patient-summary"><strong>'+escape(task.patientName)+'</strong><p>床號 '+escape(task.bedNo)+'　｜　病歷號 '+escape(task.mrn)+'</p><p>'+escape(task.taskId)+'</p></div>';
}
function validId(id){return typeof id==="string"&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);}
function link(pageKey,text,id=""){
  return '<a class="button secondary" href="'+ENTRY_ROUTES[pageKey]+(id?'?'+new URLSearchParams({task:id}):'')+'">'+escape(text)+'</a>';
}
function renderCreate(){
  const values=state.draft;
  $("#entryContent").innerHTML='<section class="card create-card">'+
    (state.original?'<div class="reorder-note">由已取消案件 '+escape(state.original.taskId)+' 重新建案。原單與取消原因會保留，新單使用新的編號。</div>':"")+
    (state.selfReport?'<h2>自起單・自回報</h2><p class="help">直接記錄此次已完成的施打。</p>':"")+
    '<form data-form="create"><label for="bedNo">床號 *</label><input id="bedNo" name="bedNo" maxlength="100" placeholder="例如：10906" autocomplete="off" required value="'+escape(values.bedNo||"")+'">'+
    '<label for="mrn">病歷號 *</label><input id="mrn" name="mrn" maxlength="100" placeholder="請輸入病歷號" inputmode="numeric" autocomplete="off" required value="'+escape(values.mrn||"")+'">'+
    '<label for="patientName">病人姓名 *</label><input id="patientName" name="patientName" maxlength="100" placeholder="請輸入病人姓名" autocomplete="off" required value="'+escape(values.patientName||"")+'">'+
    (state.selfReport?reportFields(values):"")+notes(values.remark||"")+
    '<button class="button primary full" type="submit">'+(state.selfReport?"送出施打回報":"送出")+'</button></form>'+
    (!state.original?'<button class="button self-report full" type="button" data-action="toggle-self">'+(state.selfReport?"改為一般建案":"自起單・自回報")+'</button>':"")+'</section>';
}
function waiting(task){
  const created=new Date(task.createdAt);if(Number.isNaN(created.getTime()))return "等待時間未記錄";
  const hours=Math.max(0,Math.floor((Date.now()-created.getTime())/3600000));
  return '等待 '+(hours>=24?Math.floor(hours/24)+' 天 ':'')+(hours%24)+' 小時';
}
function taskCard(task){
  const booking=page==="booking",date=new Date(task.createdAt);
  return '<article class="card case-card"><h3>'+escape(task.patientName)+'</h3><p class="patient-meta"><span>床號 '+escape(task.bedNo)+'</span><span>｜ 病歷號 '+escape(task.mrn)+'</span></p>'+
    '<p class="task-number">任務編號：'+escape(task.taskId)+'</p>'+
    (!booking?'<p class="case-time">起單時間 '+(Number.isNaN(date.getTime())?'未記錄':dateFormat.format(date))+'</p><p class="assignee">接單者：'+escape(task.claimedBy||"未記錄")+'</p><p class="waiting">'+waiting(task)+'</p>':"")+
    (task.hasDifficultHistory?'<p class="difficult">曾有困難放置紀錄</p>':"")+
    (task.remark?'<p class="help">備註：'+escape(task.remark)+'</p>':"")+
    (booking?'<form data-form="claim" data-id="'+escape(task.id)+'"><label for="operator-'+escape(task.id)+'">施打人</label><select id="operator-'+escape(task.id)+'" name="operatorId" required>'+memberOptions()+'</select><button type="submit" class="button primary">預約施打</button></form>':
      '<div class="case-actions"><button type="button" class="button primary" data-action="complete" data-id="'+escape(task.id)+'">回報完成</button></div>')+
    '<div class="case-cancel"><button type="button" class="quiet-button" data-action="cancel" data-id="'+escape(task.id)+'">取消施打</button></div></article>';
}
function renderList(){
  $("#entryContent").innerHTML='<div class="toolbar"><span>'+state.tasks.length+' 筆'+(page==="booking"?'待預約':'待施打')+'案件</span><button type="button" class="quiet-button" data-action="refresh">重新整理</button></div>'+
    (state.tasks.length?state.tasks.map(taskCard).join(""):'<section class="card empty"><h2>目前沒有'+(page==="booking"?'待預約':'待施打')+'案件</h2><p>'+(page==="booking"?'新案件建立後會出現在這裡。':'預約完成後，案件會出現在這裡。')+'</p>'+link(page==="booking"?'create':'booking',page==="booking"?'PICC 建案':'前往預約施打')+'</section>');
}
function findTask(id){const task=state.tasks.find(task=>task.id===id);if(!task)throw new Error("找不到此案件，請重新整理清單");return task;}
function dialog(title,body){$("#dialogTitle").textContent=title;$("#dialogBody").innerHTML=body;if(!$("#entryDialog").open)$("#entryDialog").showModal();}
function openComplete(task){
  state.activeTask=task;
  dialog("施打回報",patientSummary(task)+'<form data-form="complete">'+reportFields({},task)+notes(task.remark||"",true)+'<div class="form-actions"><button type="button" class="button secondary" data-action="close-dialog">返回清單</button><button type="submit" class="button primary">確認完成回報</button></div><p class="field-error" id="dialogError" role="alert" hidden></p></form>');
}
function openCancel(task){
  state.activeTask=task;
  dialog("取消施打",patientSummary(task)+'<p class="dialog-note">取消後保留原單與原因。若之後需要施打，請重新建案；此單不計入完成施打量。</p><form data-form="cancel"><label for="reason">取消原因 *</label><select id="reason" name="reason" required>'+options(client.state.config.cancelReasons)+'</select><label for="cancelDetail">補充說明</label><textarea id="cancelDetail" name="detail" maxlength="1000" placeholder="選擇「其他」時請填寫說明"></textarea><div class="form-actions"><button type="button" class="button secondary" data-action="close-dialog">返回清單</button><button type="submit" class="button danger">確認取消施打</button></div><p class="field-error" id="dialogError" role="alert" hidden></p></form>');
}
async function loadPage(){
  const version=++state.loadVersion;
  if(page==="create"){
    const members=await client.members();
    let original=null;
    const source=new URLSearchParams(location.search).get("from");
    if(source){if(!validId(source))throw new Error("重新建案連結無效");original=(await client.detail(source)).task;if(original.status!=="cancelled")throw new Error("只有已取消案件可重新建案");}
    if(version!==state.loadVersion||!client.state.actor)return;
    state.members=members;state.original=original;
    if(original)state.draft={bedNo:original.bedNo,mrn:original.mrn,patientName:original.patientName,remark:""};
    renderCreate();
  }else{
    const [members,tasks]=await Promise.all([client.members(),client.list(page)]);
    if(version!==state.loadVersion||!client.state.actor)return;
    state.members=members;state.tasks=tasks;renderList();
    const taskId=new URLSearchParams(location.search).get("task");
    if(page==="report"&&taskId&&!state.initialTaskOpened){
      state.initialTaskOpened=true;if(!validId(taskId))throw new Error("回報連結無效");
      const selected=tasks.find(task=>task.id===taskId);
      if(selected)openComplete(selected);else message("此案件已不在待施打清單，請確認是否已完成回報或取消。",true);
    }
  }
}
async function enter(){
  $("#entryContent").hidden=false;
  $("#entryContent").innerHTML='<p class="loading">正在讀取資料…</p>';
  await loadPage();
}
async function afterWrite(task,text,extra=""){
  state.tasks=state.tasks.filter(item=>item.id!==task.id);renderList();
  try{await loadPage();}
  catch(error){
    if(!client.state.actor){message("本次操作已儲存，請重新整理查看結果。");return;}
    message(text+" 清單暫時無法更新，請稍後重新整理。",false,extra);return;
  }
  message(text,false,extra);
}
function showFailure(error){
  const dialogError=$("#dialogError");
  if($("#entryDialog").open&&dialogError){dialogError.hidden=false;dialogError.textContent=error.message;}
  else message(error.message,true);
}
async function busy(button,operation){
  if(state.busy)return;
  state.busy=true;const text=button?.textContent;if(button){button.disabled=true;button.textContent="處理中…";}
  try{await operation();}catch(error){showFailure(error);}
  finally{state.busy=false;if(button){button.disabled=false;button.textContent=text;}}
}
document.addEventListener("click",async event=>{
  const button=event.target.closest("button[data-action]");if(!button||state.busy)return;
  const action=button.dataset.action;
  try{
    if(action==="close-dialog")$("#entryDialog").close();
    else if(action==="toggle-self"){
      state.draft={...state.draft,...Object.fromEntries(new FormData($('form[data-form="create"]')))};
      state.selfReport=!state.selfReport;renderCreate();
    }else if(action==="complete")openComplete(findTask(button.dataset.id));
    else if(action==="cancel")openCancel(findTask(button.dataset.id));
    else if(action==="refresh")await busy(button,loadPage);
  }catch(error){showFailure(error);}
});
document.addEventListener("change",event=>{if(event.target.id==="reason")$("#cancelDetail").required=event.target.value==="其他";});
$("#entryDialog").addEventListener("cancel",event=>{if(state.busy)event.preventDefault();});
document.addEventListener("submit",async event=>{
  const form=event.target.closest("form[data-form]");if(!form)return;event.preventDefault();
  const values=Object.fromEntries(new FormData(form));
  await busy(form.querySelector('button[type="submit"]'),async()=>{
    if(form.dataset.form==="create"){
      const task=await client.create({...values,selfReport:state.selfReport,...(state.original?{copiedFromTaskId:state.original.id}:{})});
      const selfReport=state.selfReport;state.draft={};state.original=null;state.selfReport=false;
      if(new URLSearchParams(location.search).has("from"))history.replaceState(null,"",location.pathname);
      renderCreate();
      message(selfReport?"已完成自起單與回報，施打量已更新。":"建案成功，案件已建立。",false,
        '<p class="receipt-details">任務編號：'+escape(task.taskId)+'</p>'+link(selfReport?'report':'booking',selfReport?'查看待施打清單':'前往預約施打'));
    }else if(form.dataset.form==="claim"){
      const task=await client.claim(findTask(form.dataset.id),values.operatorId);
      await afterWrite(task,"預約完成，案件已移至待施打清單。",link("report","前往施打回報",task.id));
    }else if(form.dataset.form==="complete"){
      const task=await client.complete(state.activeTask,values);$("#entryDialog").close();
      await afterWrite(task,"完成回報已儲存，施打量已更新。案件已從待施打清單移除。");
    }else if(form.dataset.form==="cancel"){
      const task=await client.cancel(state.activeTask,values.reason,values.detail||"");
      $("#entryDialog").close();
      await afterWrite(task,"已取消施打，原單與取消原因均已保留。",
        '<p class="receipt-details">取消原因：'+escape(task.cancelReason)+(task.cancelDetail?'；'+escape(task.cancelDetail):'')+'</p><a class="button secondary" href="'+ENTRY_ROUTES.create+'?'+new URLSearchParams({from:task.id})+'">需要再次施打時，重新建案</a>');
    }
  });
});
async function boot(){
  try{
    await client.boot();
    const config=client.state.config;
    $("#previewLabel").hidden=!config.demo;
    await enter();
  }catch(error){message(error.message,true);}
}
boot();
