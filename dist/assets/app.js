"use strict";
const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, x => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[x]));
const icons = {
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  user:'<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  users:'<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5v1"/>',
  chart:'<path d="M3 3v18h18M7 16v-5m5 5V6m5 10V9"/>',
  table:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16M15 10v10"/>',
  bell:'<path d="M5 16v-6a7 7 0 0 1 14 0v6l2 2H3zm4 5h6"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 14-3l1 2M4 17l1 2a8 8 0 0 0 14-3"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  cross:'<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>',
  logout:'<path d="M9 3H4v18h5m5-14 5 5-5 5m-5-5h10"/>',
  file:'<path d="M14 3H5v18h14V8zm0 0v5h5M8 12h8m-8 4h8"/>'
};
const icon = name => '<svg viewBox="0 0 24 24" aria-hidden="true">'+(icons[name]||icons.file)+'</svg>';
function decorate(root = document) {
  root.querySelectorAll("[data-icon]").forEach(el => {el.innerHTML = icon(el.dataset.icon);});
  root.querySelectorAll("[data-width]").forEach(el => {el.style.width = Math.max(0, Math.min(100, +el.dataset.width))+"%";});
  root.querySelectorAll("[data-height]").forEach(el => {el.style.height = Math.max(4, Math.min(150, +el.dataset.height))+"px";});
}
const labels = {active:"進行中",pending:"待預約",claimed:"待施打",awaiting_report:"待回報",completed:"完成",cancelled:"已取消"};
const activeStatuses=["pending","claimed","awaiting_report"];
const eventLabels = {created:"建立任務",claimed:"預約施打",awaiting_report:"已施打，待回報",completed:"完成回報",self_completed:"自起單・自回報",cancelled:"取消施打",reordered:"再次起單",reordered_created:"由取消案件重新起單",edited:"更新資料",removed:"移除案件",imported:"匯入舊資料",member_updated:"更新團隊成員",announcement_requested:"待施打公告",announce_pending:"待施打公告"};
const state = {ready:false,mineUserId:"",user:null,csrf:"",config:{},view:"board",status:"pending",query:"",tasks:[],users:[],stats:{},page:1,pageSize:30,adminStart:"",adminEnd:"",statsStart:"",statsEnd:"",statsScope:"all",requestId:"",detail:null};
const dateFormatter = new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
function fmt(value) { if (!value) return "未記錄"; const d = new Date(value); return Number.isNaN(d.getTime()) ? "未記錄" : dateFormatter.format(d); }
function taipeiDate(d = new Date()) { return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(d); }
function waiting(t) { const end = t.completedAt || t.cancelledAt || new Date(); const h = Math.max(0,Math.floor((new Date(end)-new Date(t.createdAt))/3600000)); return h >= 24 ? Math.floor(h/24)+" 天 "+h%24+" 小時" : h+" 小時"; }
function toast(message, error = false) { const el=$("#toast"); el.textContent=message; el.classList.toggle("error",error); el.hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>{el.hidden=true;},5000); }
async function api(path, options = {}) {
  if(window.PiccSupabase?.enabled())return window.PiccSupabase.workspaceApi(path,options);
  const headers = new Headers(options.headers || {});
  if (options.method && options.method !== "GET") headers.set("X-CSRF-Token",state.csrf);
  let body = options.body;
  if (body && !(body instanceof FormData)) {headers.set("Content-Type","application/json"); body=JSON.stringify(body);}
  const res=await fetch(path.replace(/^\/api\//,"/api/workspace/"),{...options,headers,body,credentials:"same-origin"});
  let data; try {data=await res.json();} catch {throw new Error("伺服器回應格式不正確，請稍後再試");}
  if(!res.ok) {if(res.status===401 && state.user){state.user=null;state.ready=false;state.tasks=[];$("#mainContent").textContent="連線已中斷，請重新整理。";} throw new Error(data.error || "操作未完成");}
  return data;
}
function userOptions(id) {
  const users=state.users.filter(u=>u.enabled),selected=users.some(u=>u.id===id);
  return (!selected?'<option value="">請選擇施打者</option>':"")+users.map(u=>'<option value="'+esc(u.id)+'" '+(u.id===id?"selected":"")+'>'+esc(u.name)+'</option>').join("");
}
function memberTasks(){return state.view==="mine"?state.tasks.filter(t=>state.mineUserId&&(t.claimedId===state.mineUserId||t.operatorId===state.mineUserId)):state.tasks;}
function options(values,current="",placeholder="請選擇") { return '<option value="">'+placeholder+'</option>'+values.map(v=>'<option '+(v===current?"selected":"")+' value="'+esc(v)+'">'+esc(v)+'</option>').join(""); }
function badge(t) { return '<span class="status '+esc(t.status)+'">'+esc(labels[t.status])+'</span>'; }
function visibleTasks() {
  let tasks=state.view==="board"?state.tasks.filter(t=>activeStatuses.includes(t.status)):state.tasks;
  tasks=tasks.filter(t=>["all","active"].includes(state.status)||t.status===state.status);
  if(state.view==="mine") tasks=tasks.filter(t=>state.mineUserId&&(t.claimedId===state.mineUserId||t.operatorId===state.mineUserId));
  if(state.query) {const q=state.query.toLowerCase(); tasks=tasks.filter(t=>[t.patientName,t.bedNo,t.mrn,t.taskId].some(x=>String(x||"").toLowerCase().includes(q)));}
  if(state.view==="admin") {
    if(state.adminStart) tasks=tasks.filter(t=>taipeiDate(new Date(t.createdAt))>=state.adminStart);
    if(state.adminEnd) tasks=tasks.filter(t=>taipeiDate(new Date(t.createdAt))<=state.adminEnd);
  }
  return tasks;
}
function modal(title, subtitle, body) {
  $("#dialogContent").innerHTML='<div class="dialog-head"><div><h2>'+esc(title)+'</h2><p>'+esc(subtitle)+'</p></div><button class="close-button" data-action="close" aria-label="關閉">'+icon("close")+'</button></div><div class="dialog-body">'+body+'</div>';
  decorate($("#dialog"));
  if(!$("#dialog").open) $("#dialog").showModal();
}
function field(label,name,value="",type="text",required=false,full=false) {
  return '<div class="field '+(full?"full":"")+'"><label for="f-'+name+'">'+label+(required?' <b>＊</b>':'')+'</label><input id="f-'+name+'" name="'+name+'" type="'+type+'" value="'+esc(value)+'" '+(required?"required":"")+' '+(type==="number"?'min="0.01" step="any"':'maxlength="100"')+'></div>';
}
function reportFields(t={}) {
  return '<div class="form-section"><h3>施打紀錄</h3><div class="form-grid">'+
  '<div class="field full"><label for="f-operatorId">實際施打者 <b>＊</b></label><select name="operatorId" id="f-operatorId" required>'+userOptions(t.operatorId || t.claimedId || state.user.id)+'</select><small>施打量依這位成員與完成日期計算。</small></div>'+
  '<div class="field"><label for="f-difficulty">放置困難度 <b>＊</b></label><select name="difficulty" id="f-difficulty" required>'+options(state.config.difficulties,t.difficulty)+'</select></div>'+
  '<div class="field"><label for="f-insertionSite">施打位置 <b>＊</b></label><select name="insertionSite" id="f-insertionSite" required>'+options(state.config.sites,t.insertionSite)+'</select></div>'+
  '<div class="field"><label for="f-vein">血管 <b>＊</b></label><select name="vein" id="f-vein" required>'+options(state.config.veins,t.vein)+'</select></div>'+
  '<div class="field"><label for="f-catheterType">管路類型 <b>＊</b></label><select name="catheterType" id="f-catheterType" required>'+options(state.config.catheters,t.catheterType)+'</select></div>'+
  field("管路長度（cm）","catheterLength",t.catheterLength || "","number",false,true)+'</div></div>';
}
function remarkField(value="") {return '<div class="field full section-spacer"><label for="f-remark">備註</label><textarea id="f-remark" name="remark" maxlength="1000" placeholder="補充施打或交接資訊（可不填）">'+esc(value)+'</textarea></div>';}
function duplicateWarning(result){
  const box=$("#duplicateWarning");box.hidden=false;
  box.innerHTML='<strong>請確認是否重複開單</strong><p>七日內已有 '+Number(result.duplicateCount)+' 筆相同病歷號的案件。請先確認，再決定是否繼續建立。</p><label><input type="checkbox" name="duplicateAcknowledged" value="true" required> 已確認，仍要建立新案件</label>';
  box.focus();
}
function formActions(label="儲存",style="primary") {return '<div class="form-actions"><button class="button secondary" type="button" data-action="close">返回</button><button type="submit" class="button '+style+'">'+esc(label)+'</button></div>';}
function patientInfo(t) {return '<div class="detail-grid"><div><small>病人姓名</small><p>'+esc(t.patientName)+'</p></div><div><small>目前狀態</small>'+badge(t)+'</div><div><small>床號</small><p>'+esc(t.bedNo)+'</p></div><div><small>病歷號</small><p>'+esc(t.mrn)+'</p></div></div>';}
function showCreate(self=false, source=null) {
  state.requestId=crypto.randomUUID();
  state.copiedFromTaskId=source?.id || "";
  modal(source?"重新起單":self?"自起單・自回報":"新增 PICC 任務",source?"原取消案件保留不變，新案件使用新的任務編號。":"填寫病人資訊，"+(self?"直接記錄此次已完成的施打。":"建立一筆待預約案件。"),
  (source?'<div class="alert">原案件 '+esc(source.taskId)+' 已取消。請確認新案件的病人資料，重新安排施打。</div>':'<div class="tabs section-spacer"><button class="tab '+(!self?"active":"")+'" data-action="create-normal">一般起單</button><button class="tab '+(self?"active":"")+'" data-action="create-self">自起單・自回報</button></div>')+
  '<form data-form="create" data-self="'+self+'" class="section-spacer"><div class="form-grid">'+field("病人姓名","patientName",source?.patientName || "","text",true,true)+field("床號","bedNo",source?.bedNo || "","text",true)+field("病歷號","mrn",source?.mrn || "","text",true)+'</div>'+(self?reportFields():"")+remarkField()+'<div id="duplicateWarning" class="alert duplicate-warning section-spacer" role="alert" tabindex="-1" hidden></div>'+formActions(self?"送出施打回報":"建立待預約任務")+'</form>');
}
function findTask(id) {const t=state.tasks.find(t=>t.id===id); if(!t) throw new Error("找不到此案件，請重新整理"); return t;}
function showClaim(id) {
  const t=findTask(id); state.detail=t;
  modal("預約施打",t.taskId,patientInfo(t)+'<form data-form="claim" data-id="'+esc(id)+'"><div class="field section-spacer"><label for="f-operatorId">預約施打者 <b>＊</b></label><select id="f-operatorId" name="operatorId" required>'+userOptions(state.user.id)+'</select><small>可協助團隊安排施打者，系統會保留操作人紀錄。</small></div>'+formActions("確認預約")+'</form>');
}
function showComplete(id) {
  const t=findTask(id); state.detail=t;
  modal("完成施打回報",t.taskId,patientInfo(t)+'<form data-form="complete" data-id="'+esc(id)+'">'+reportFields(t)+remarkField(t.remark)+formActions("確認完成回報")+'</form>');
}
function showPerformed(id){
  const t=findTask(id);state.detail=t;
  modal("已施打，待回報",t.taskId,patientInfo(t)+'<p class="alert info-alert section-spacer">確認已施打後，案件會保留在「待回報」。送出完整施打回報後，才計入完成施打量。</p><form data-form="performed" data-id="'+esc(id)+'">'+formActions("確認移至待回報")+'</form>');
}
function showCancel(id) {
  const t=findTask(id); state.detail=t;
  modal("取消施打",t.taskId,patientInfo(t)+'<div class="alert section-spacer">取消後會保留案件與原因，並從待預約／待施打清單移出。取消案件不計入完成施打量。</div>'+
  '<form data-form="cancel" data-id="'+esc(id)+'"><div class="field"><label for="f-reason">取消原因 <b>＊</b></label><select id="f-reason" name="reason" required>'+options(state.config.cancelReasons)+'</select></div><div class="field section-spacer"><label for="f-detail">補充說明</label><textarea id="f-detail" name="detail" maxlength="1000" placeholder="選擇「其他」時請填寫說明"></textarea></div>'+formActions("確認取消施打","warning")+'</form>');
}
function showReorder(id) {
  showCreate(false,findTask(id));
}
function showEdit(id) {
  const t=findTask(id); state.detail=t;
  const completionValue=t.completedAt?taipeiDate(new Date(t.completedAt))+"T"+new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Taipei",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(t.completedAt)):"";
  const assigned=t.status==="claimed"?'<div class="field section-spacer"><label for="f-claimedId">調整接單者</label><select id="f-claimedId" name="claimedId">'+userOptions(t.claimedId)+'</select></div>':"";
  const reported=t.status==="completed"?'<div class="section-spacer"><label><input type="checkbox" id="editReportToggle" name="editReport" value="true"> 同時修正施打紀錄</label><p class="muted">原施打者：'+esc(t.operatorName||"未記錄")+'。僅修改基本資料不會改變施打量。</p><fieldset id="editReportFields" disabled hidden>'+reportFields(t)+field("實際完成時間（臺灣時間）","completedAt",completionValue,"datetime-local")+'<p class="muted">只有確認實際時間時才補填；空白保留原記錄。</p></fieldset></div>':"";
  modal("編輯案件",t.taskId,'<form data-form="edit" data-id="'+esc(id)+'"><div class="form-grid">'+field("病人姓名","patientName",t.patientName,"text",true,true)+field("床號","bedNo",t.bedNo,"text",true)+field("病歷號","mrn",t.mrn,"text",true)+'</div>'+assigned+reported+remarkField(t.remark)+'<p class="muted section-spacer">取消紀錄保留；需要再次施打時請重新起單。每次修改均留下紀錄。</p>'+formActions("儲存更新")+'</form>');
}
function showRemove(id) {
  const t=findTask(id); state.detail=t;
  modal("移除案件",t.taskId,patientInfo(t)+'<div class="alert section-spacer">此案件會從工作清單與統計移除。系統保留原始資料與操作紀錄，取消施打請使用「取消」功能。</div><form data-form="remove" data-id="'+esc(id)+'"><div class="field"><label for="f-reason">移除原因 <b>＊</b></label><textarea id="f-reason" name="reason" required maxlength="1000"></textarea></div>'+formActions("確認移除","danger")+'</form>');
}
async function showDetail(id) {
  const data=await api("/api/tasks/"+encodeURIComponent(id)); const t=data.task;
  const details=[["起單時間",fmt(t.createdAt)],["接單者",t.claimedBy || "尚未接單"],["實際施打者",t.operatorName || "尚未回報"],["完成時間",t.completedAt?fmt(t.completedAt):"未記錄"],["管路類型",t.catheterType || "—"],["管路長度",t.catheterLength?t.catheterLength+" cm":"—"],["施打位置",t.insertionSite || "—"],["血管",t.vein || "—"],["困難度",t.difficulty || "—"]];
  let content=patientInfo(t)+'<div class="detail-grid form-section">'+details.map(([k,v])=>'<div><small>'+esc(k)+'</small><p>'+esc(v)+'</p></div>').join("")+'</div>';
  if(t.reorderOf)content+='<div class="alert info-alert section-spacer">這是由取消案件重新建立的任務。<button class="button text-button small-button" data-action="detail" data-id="'+esc(t.reorderOf)+'">查看原取消案件</button></div>';
  if(t.remark) content+='<div class="form-section"><h3>備註</h3><p>'+esc(t.remark)+'</p></div>';
  if(t.status==="cancelled") content+='<div class="alert section-spacer"><strong>取消原因：'+esc(t.cancelReason)+'</strong><p>'+esc(t.cancelDetail)+'</p><small>'+fmt(t.cancelledAt)+'</small></div>';
  content+='<div class="form-section"><h3>案件歷程</h3><div class="timeline">'+data.events.map(e=>'<div class="timeline-entry"><b>'+esc(eventLabels[e.action]||e.action)+'</b><small>'+esc(e.actorName)+' · '+fmt(e.occurredAt)+'</small>'+(e.detail.reason?'<p>'+esc(e.detail.reason)+(e.detail.detail?' · '+esc(e.detail.detail):"")+'</p>':"")+(e.detail.newTaskId?'<p>新任務 '+esc(e.detail.newTaskNumber)+' <button class="button text-button small-button" data-action="detail" data-id="'+esc(e.detail.newTaskId)+'">查看新案件</button></p>':"")+'</div>').join("")+'</div></div><div class="form-actions">'+taskButtons(t,true)+'<button class="button secondary" data-action="close">關閉</button></div>';
  modal("案件詳情",t.taskId,content);
}
function taskButtons(t,detail=false) {
  let html="";
  if(t.status==="pending") html+='<button class="button '+(detail?"primary":"secondary")+'" data-action="claim" data-id="'+esc(t.id)+'">預約施打</button>';
  if(t.status==="claimed") html+='<button class="button secondary" data-action="performed" data-id="'+esc(t.id)+'">已施打，待回報</button>';
  if(["claimed","awaiting_report"].includes(t.status)) html+='<button class="button primary" data-action="complete" data-id="'+esc(t.id)+'">'+icon("check")+'回報完成</button>';
  if(["pending","claimed"].includes(t.status)) html+='<button class="button '+(detail?"warning":"text-button")+'" data-action="cancel" data-id="'+esc(t.id)+'">取消</button>';
  if(t.status==="cancelled") html+='<button class="button secondary" data-action="reorder" data-id="'+esc(t.id)+'">重新起單</button>';
  return html;
}
function card(t) {
  return '<article class="task-card"><div class="patient-icon">'+icon("user")+'</div><div class="task-copy"><div class="patient-name">'+esc(t.patientName)+' '+badge(t)+(t.hasDifficultHistory?'<span class="difficult">曾有困難放置紀錄</span>':"")+'</div><div class="patient-meta"><span>床號 '+esc(t.bedNo)+'</span><span>病歷號 '+esc(t.mrn)+'</span></div><div class="task-note"><span>'+icon("clock")+' '+fmt(t.createdAt)+'</span>'+(["claimed","awaiting_report"].includes(t.status)?'<span>接單者 '+esc(t.claimedBy)+'</span>':"")+(t.status==="completed"?'<span>施打者 '+esc(t.operatorName)+'</span>':"")+(t.status==="cancelled"?'<span>'+esc(t.cancelReason)+'</span>':'<span class="wait">'+(t.status==="completed"?"處理時間 ":"等待 ")+waiting(t)+'</span>')+'</div></div><div class="task-actions">'+taskButtons(t)+'<button class="task-open" data-action="detail" data-id="'+esc(t.id)+'" aria-label="查看 '+esc(t.patientName)+' 詳情">'+icon("chevron")+'</button></div></article>';
}
function empty(message="目前沒有符合條件的案件",hint="試試切換狀態或搜尋條件。") {return '<div class="empty"><div class="empty-icon">'+icon("file")+'</div><h3>'+esc(message)+'</h3><p>'+esc(hint)+'</p></div>';}
function statusTabs() {
  const source=state.view==="board"?state.tasks.filter(t=>activeStatuses.includes(t.status)):memberTasks();
  const statuses=state.view==="board"?["active",...activeStatuses]:["all",...activeStatuses,"completed","cancelled"];
  return '<div class="tabs">'+statuses.map(s=>'<button class="tab '+(state.status===s?"active":"")+'" data-status="'+s+'">'+(s==="all"?"全部":labels[s])+'<span>'+source.filter(t=>["all","active"].includes(s)||t.status===s).length+'</span></button>').join("")+'</div>';
}
function searchBox(){return '<div class="search-wrap">'+icon("search")+'<input id="taskSearch" placeholder="姓名、床號或病歷號" aria-label="搜尋案件" value="'+esc(state.query)+'"></div>';}
function metrics() {
  const entries=[["pending","待預約","等待團隊安排","clock"],["claimed","待施打","已由團隊成員接單","user"],["completed","已完成","已完成施打回報","check"],["cancelled","已取消","保留取消原因與紀錄","close"]];
  return '<div class="metrics">'+entries.map(([s,label,hint,i])=>'<button class="metric" data-status="'+s+'" aria-pressed="'+(state.status===s)+'"><div class="metric-head">'+label+'<span class="metric-icon">'+icon(i)+'</span></div><div class="metric-number">'+memberTasks().filter(t=>t.status===s).length+'</div><small>'+hint+'</small></button>').join("")+'</div>';
}
function renderBoard() {
  const tasks=visibleTasks();
  const list=tasks.length?tasks.map(card).join(""):empty("目前沒有符合條件的進行中案件","完成與取消案件可至「全部案件」查閱。");
  return '<section class="panel board-panel active-workbench"><div class="panel-head"><h2>進行中案件</h2><small>'+tasks.length+' 筆案件</small></div><div class="board-toolbar">'+statusTabs()+searchBox()+'</div><div class="task-list">'+list+'</div></section>';
}
function chart(items) {
  if(!items.length)return empty("此期間沒有統計資料","可調整日期範圍。");
  const max=Math.max(1,...items.map(i=>i.count));
  return '<div class="chart">'+items.map(i=>'<div class="chart-column"><strong>'+i.count+'</strong><div class="chart-bar" data-height="'+Math.round(i.count/max*135)+'"></div><span>'+esc(i.month)+'</span></div>').join("")+'</div>';
}
function renderStats() {
  const s=state.stats, operators=s.operators||[], total=s.totalCompleted||0, difficult=operators.reduce((a,b)=>a+b.difficultCount,0);
  return '<div class="filters"><div class="field"><label for="statsStart">完成日期從</label><input id="statsStart" type="date" value="'+state.statsStart+'"></div><div class="field"><label for="statsEnd">完成日期至</label><input id="statsEnd" type="date" value="'+state.statsEnd+'"></div><button class="button primary" data-action="filter-stats">查詢</button><button class="button secondary" data-action="all-stats">不限日期</button><button class="button secondary" data-action="export-stats">'+icon("download")+'統計 CSV</button></div>'+
  '<div class="alert info-alert">'+esc(s.basis||"")+'</div>'+
  (s.missingCompletionDate?'<div class="alert">有 '+s.missingCompletionDate+' 筆舊完成案件缺少完成日期。不限日期的總量保留，期間與逐月施打量不納入這些案件。</div>':"")+
  '<div class="summary-row"><div class="summary-tile"><p>完成施打量</p><b>'+total+'</b><small>取消案件不計入</small></div><div class="summary-tile"><p>實際施打者</p><b>'+operators.length+'</b><small>依本次查詢範圍</small></div><div class="summary-tile"><p>困難／非常困難</p><b>'+difficult+'</b><small>完成案件的放置紀錄</small></div></div>'+
  '<section class="panel"><div class="panel-head"><h2>個別施打者完成量</h2><small>以完成日期統計</small></div><div class="table-scroll"><table><thead><tr><th>施打者</th><th>完成量</th><th>困難案件</th><th>佔完成量</th></tr></thead><tbody>'+operators.map(o=>'<tr><td><strong>'+esc(o.operatorName)+'</strong>'+(o.operatorId===state.user.id?'<small>您的施打紀錄</small>':"")+'</td><td><strong>'+o.count+' 筆</strong></td><td>'+o.difficultCount+' 筆</td><td><div class="volume-bar"><div class="volume-track"><div class="volume-fill" data-width="'+(total?o.count/total*100:0)+'"></div></div><span>'+(total?Math.round(o.count/total*100):0)+'%</span></div></td></tr>').join("")+'</tbody></table>'+(operators.length?"":empty("此期間沒有完成施打紀錄"))+'</div></section>'+
  '<div class="stat-columns"><section class="panel"><div class="panel-head"><h2>逐月完成施打量</h2><small>完成月份</small></div><div class="panel-body">'+chart(s.months||[])+'</div></section><section class="panel"><div class="panel-head"><h2>逐月起單案件數</h2><small>全部案件 · 起單月份</small></div><div class="panel-body">'+chart(s.createdMonths||[])+'</div></section></div>';
}
function renderAdmin() {
  const tasks=visibleTasks(), pages=Math.max(1,Math.ceil(tasks.length/state.pageSize)); state.page=Math.min(state.page,pages);
  const rows=tasks.slice((state.page-1)*state.pageSize,state.page*state.pageSize);
  const monthCounts={};
  state.tasks.filter(t=>(!state.adminStart||taipeiDate(new Date(t.createdAt))>=state.adminStart)&&(!state.adminEnd||taipeiDate(new Date(t.createdAt))<=state.adminEnd)).forEach(t=>{const month=taipeiDate(new Date(t.createdAt)).slice(0,7);monthCounts[month]=(monthCounts[month]||0)+1;});
  const createdMonths=Object.entries(monthCounts).sort(([a],[b])=>a.localeCompare(b)).map(([month,count])=>({month,count}));
  return '<div class="tabs section-spacer"><button class="tab active">案件紀錄</button><button class="tab" data-view="members">團隊成員</button><button class="tab" data-view="notifications">通知紀錄</button></div><div class="filters section-spacer"><div class="field"><label for="adminStart">起單日期從</label><input id="adminStart" type="date" value="'+state.adminStart+'"></div><div class="field"><label for="adminEnd">起單日期至</label><input id="adminEnd" type="date" value="'+state.adminEnd+'"></div><button class="button primary" data-action="filter-admin">查詢</button><button class="button secondary" data-action="export-tasks">'+icon("download")+'案件 CSV</button><button class="button secondary" data-action="import">'+icon("file")+'匯入舊資料</button></div>'+
  '<section class="panel"><div class="board-toolbar">'+statusTabs()+searchBox()+'</div><div class="table-scroll"><table><thead><tr><th>任務／時間</th><th>病人／病歷號</th><th>狀態</th><th>接單／施打者</th><th>管路／部位</th><th>困難度／備註</th><th>操作</th></tr></thead><tbody>'+
  rows.map(t=>'<tr><td><strong>'+esc(t.taskId)+'</strong><small>'+fmt(t.createdAt)+'</small></td><td><strong>'+esc(t.patientName)+'</strong><small>'+esc(t.bedNo)+' · '+esc(t.mrn)+'</small></td><td>'+badge(t)+'</td><td>'+esc(t.claimedBy||"—")+'<small>施打 '+esc(t.operatorName||"—")+'</small></td><td>'+esc(t.catheterType||"—")+(t.catheterLength?' · '+t.catheterLength+' cm':"")+'<small>'+esc(t.insertionSite||"—")+' · '+esc(t.vein||"—")+'</small></td><td>'+esc(t.difficulty||"—")+'<small>'+esc(t.status==="cancelled"?t.cancelReason:t.remark)+'</small></td><td><div class="table-actions"><button class="button text-button" data-action="detail" data-id="'+esc(t.id)+'">詳情</button><button class="button secondary" data-action="edit" data-id="'+esc(t.id)+'">編輯</button><button class="button text-button" data-action="remove" data-id="'+esc(t.id)+'">移除</button></div></td></tr>').join("")+
  '</tbody></table>'+(rows.length?"":empty())+'</div><div class="pager"><span>共 '+tasks.length+' 筆 · 第 '+state.page+' / '+pages+' 頁</span><div><select id="pageSize" aria-label="每頁筆數">'+[10,20,30,50,100].map(n=>'<option '+(state.pageSize===n?"selected":"")+'>'+n+'</option>').join("")+'</select><button class="button secondary small-button" data-action="prev-page" '+(state.page<=1?"disabled":"")+'>上一頁</button><button class="button secondary small-button" data-action="next-page" '+(state.page>=pages?"disabled":"")+'>下一頁</button></div></div></section><section class="panel section-spacer"><div class="panel-head"><h2>逐月 PICC 起單案件數</h2><small>目前起單日期範圍</small></div><div class="panel-body">'+chart(createdMonths)+'</div></section>';
}
function showMember(id) {
  const u=state.users.find(u=>u.id===id)||{};
  modal(u.id?"編輯施打者":"新增施打者","名單用於預約及實際施打者選擇。",'<form data-form="member" data-id="'+esc(u.id||"")+'"><input type="hidden" name="role" value="'+esc(u.role||"operator")+'"><div class="form-grid">'+field("姓名","name",u.name,"text",true,true)+'<div class="field full"><label for="f-enabled">名單狀態</label><select id="f-enabled" name="enabled"><option value="true">啟用</option><option value="false" '+(u.enabled===0?"selected":"")+'>停用</option></select></div></div>'+formActions("儲存施打者")+'</form>');
}
function renderMembers() {
  return '<div class="filters"><button class="button primary" data-action="member">'+icon("plus")+'新增施打者</button></div><div class="member-grid">'+state.users.map(u=>'<article class="member-card"><span class="avatar">'+esc(u.name.slice(0,1))+'</span><h3>'+esc(u.name)+'</h3><small>'+(u.enabled?"啟用":"停用")+'</small><button class="button secondary" data-action="member" data-id="'+esc(u.id)+'">編輯施打者</button></article>').join("")+'</div>';
}
async function renderNotifications() {
  const data=await api("/api/notifications");
  if(data.deferred||state.config.notificationsEnabled===false)return '<div class="alert info-alert">LINE 群組通知會在下一階段啟用，目前先完成案件與統計功能。</div><section class="panel"><div class="panel-head"><h2>LINE 通知（待串接）</h2><button class="button secondary small-button" data-action="announce">預覽待施打清單</button></div>'+empty("LINE 通知尚未啟用","可先預覽待施打清單，案件操作不會發送訊息。")+'</section>';
  const status={simulated:"示範紀錄（未發送）",queued:"待發送",sent:"服務確認送出",failed:"發送未完成",sending:"發送中"};
  return '<div class="alert info-alert">案件寫入與通知結果分開記錄。通知未完成時可重試，無需重複建立或回報案件。</div><section class="panel"><div class="panel-head"><h2>LINE 通知紀錄</h2><button class="button secondary small-button" data-action="announce">預覽待施打公告</button></div><div class="table-scroll"><table><thead><tr><th>時間</th><th>通知事件</th><th>操作人</th><th>狀態</th><th>操作</th></tr></thead><tbody>'+data.notifications.map(n=>'<tr><td>'+fmt(n.created_at)+'</td><td>'+esc(eventLabels[n.event]||n.event)+'</td><td>'+esc(n.actor_name)+'</td><td>'+esc(status[n.status]||n.status)+(n.last_error?'<small>'+esc(n.last_error)+'</small>':"")+'</td><td>'+((n.status==="queued"||n.status==="failed")?'<button class="button secondary small-button" data-action="retry" data-id="'+n.id+'">重試通知</button>':"—")+'</td></tr>').join("")+'</tbody></table>'+(data.notifications.length?"":empty("還沒有通知紀錄","新增或更新案件後會顯示於此。"))+'</div></section>';
}
const viewInfo={board:["TEAM WORKSPACE","工作台","聚焦待預約、待施打與待回報；完成後可至全部案件查閱。"],mine:["TEAM MEMBERS","成員案件","選擇施打者，查看接單與完成紀錄。"],stats:["PRACTICE INSIGHTS","施打統計","按實際施打者與完成日期，掌握個別施打量。"],admin:["TASK MANAGEMENT","全部案件","查詢、編輯與匯出團隊的完整案件紀錄。"],members:["TEAM MEMBERS","團隊成員","維護施打者名單與啟用狀態。"],notifications:["TEAM NOTIFICATIONS","通知紀錄","追蹤 LINE 通知，分別確認案件與訊息的結果。"]};
let renderVersion=0;
async function render() {
  const version=++renderVersion, info=viewInfo[state.view];
  $("#viewEyebrow").textContent=info[0];$("#viewTitle").textContent=info[1];$("#viewDescription").textContent=info[2];
  document.querySelectorAll("[data-view]").forEach(el=>el.classList.toggle("active",el.dataset.view===state.view));
  let html;
  if(state.view==="stats") {await loadStats(); html=renderStats();}
  else if(state.view==="admin") html=renderAdmin();
  else if(state.view==="members") html=renderMembers();
  else if(state.view==="notifications") html=await renderNotifications();
  else html=renderBoard();
  if(version!==renderVersion)return;
  const searchFocused=document.activeElement?.id==="taskSearch", selection=document.activeElement?.selectionStart;
  $("#mainContent").innerHTML=html;decorate($("#mainContent"));
  if(searchFocused&&$("#taskSearch")){$("#taskSearch").focus();$("#taskSearch").setSelectionRange(selection,selection);}
}
async function loadStats() {
  const q=new URLSearchParams({scope:state.statsScope});
  if(state.statsStart)q.set("start",state.statsStart);if(state.statsEnd)q.set("end",state.statsEnd);
  state.stats=await api("/api/stats?"+q);
}
async function refresh() {
  const [tasks,users]=await Promise.all([api("/api/tasks"),api("/api/users")]);
  state.tasks=tasks.tasks;state.users=users.users;await loadStats();await render();
  $("#updatedTime").textContent="更新於 "+new Intl.DateTimeFormat("zh-TW",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Taipei",hour12:false}).format(new Date());
}
async function enter(data) {
  state.user=data.user;state.csrf=data.csrf;
  $("#app").hidden=false;$("#demoBanner").hidden=!(state.config.demo||state.config.trialMode);
  if(state.config.trialMode)$("#demoBanner").textContent="測試環境 · 使用假資料";
  $("#profileName").textContent="PICC 團隊";$("#profileInitial").textContent="P";$("#profileRole").textContent="共用工作站";
  document.querySelectorAll(".admin-only").forEach(el=>{el.hidden=state.user.role!=="admin";});
  state.view="board";state.status="active";
  const today=taipeiDate();state.statsStart=today.slice(0,8)+"01";state.statsEnd=today;state.statsScope=state.user.role==="admin"?"all":"mine";
  $("#today").textContent=new Intl.DateTimeFormat("zh-TW",{year:"numeric",month:"long",day:"numeric",weekday:"long",timeZone:"Asia/Taipei"}).format(new Date());
  await refresh();
}
function downloadCSV(rows, filename) {
  const cell=v=>{let s=String(v??"");if(/^\s*[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
  const blob=new Blob(["\ufeff"+rows.map(r=>r.map(cell).join(",")).join("\r\n")],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function showImport() {
  modal("匯入舊版案件","支援舊版後台匯出的 UTF-8 CSV。",'<div class="alert">匯入會保留任務編號，重複案件會略過。舊檔若缺少完成時間，不會以起單時間代替。資料只進入這個新版的獨立資料庫。</div><form data-form="import"><div class="field"><label for="importFile">選擇 CSV</label><input id="importFile" name="file" type="file" accept=".csv,text/csv" required></div>'+formActions("匯入資料")+'</form>');
}
function showAnnouncement() {
  const tasks=state.tasks.filter(t=>t.status==="claimed");
  modal("待施打清單公告","本階段僅預覽內容，LINE 通知於後續串接。",'<div class="alert">LINE 通知尚未啟用，目前不會發送訊息。</div>'+
  (tasks.length?'<div class="task-list">'+tasks.map(t=>'<div class="task-card"><div class="task-copy"><strong>'+esc(t.patientName)+'</strong><div class="patient-meta">床號 '+esc(t.bedNo)+' · 接單者 '+esc(t.claimedBy)+'</div></div><span class="wait">等待 '+waiting(t)+'</span></div>').join("")+'</div>':empty("目前沒有待施打案件"))+'<div class="form-actions"><button class="button secondary" data-action="close">關閉預覽</button></div>');
}
const actions={
  close:()=>$("#dialog").close(),"create-normal":()=>showCreate(false),"create-self":()=>showCreate(true),
  claim:showClaim,performed:showPerformed,complete:showComplete,cancel:showCancel,reorder:showReorder,edit:showEdit,remove:showRemove,detail:showDetail,member:showMember,import:showImport,announce:showAnnouncement,
  "filter-stats":async()=>{const start=$("#statsStart").value,end=$("#statsEnd").value;if(start&&end&&start>end)throw new Error("開始日期不能晚於結束日期");state.statsStart=start;state.statsEnd=end;state.statsScope="all";await render();},
  "all-stats":async()=>{state.statsStart="";state.statsEnd="";state.statsScope="all";await render();},
  "filter-admin":()=>{const start=$("#adminStart").value,end=$("#adminEnd").value;if(start&&end&&start>end)throw new Error("開始日期不能晚於結束日期");state.adminStart=start;state.adminEnd=end;state.page=1;return render();},
  "prev-page":()=>{state.page--;return render();},"next-page":()=>{state.page++;return render();},
  "export-tasks":async()=>{const q=new URLSearchParams();if(state.adminStart)q.set("start",state.adminStart);if(state.adminEnd)q.set("end",state.adminEnd);if(!window.PiccSupabase?.enabled()){window.location.href="/api/workspace/export?"+q;return;}const data=await api("/api/export?"+q);const keys=["createdAt","taskId","patientName","bedNo","mrn","statusLabel","claimedBy","operatorName","catheterType","catheterLength","insertionSite","vein","difficulty","remark","completedAt","cancelledAt","cancelReason","cancelDetail"];downloadCSV([["起單時間","任務編號","病人姓名","床號","病歷號","Status","接單者","施打者","管路種類","管路長度(cm)","部位","血管","困難度","備註","完成時間","取消時間","取消原因","取消說明"],...data.tasks.map(t=>keys.map(k=>t[k]??""))],"PICC-案件.csv");},
  "export-stats":()=>downloadCSV([["統計起日","統計迄日","施打者","完成量","困難／非常困難量"],...(state.stats.operators||[]).map(o=>[state.statsStart||"不限",state.statsEnd||"不限",o.operatorName,o.count,o.difficultCount])],"PICC-施打量.csv"),
  retry:async id=>{const result=await api("/api/notifications/"+id+"/retry",{method:"POST",body:{}});toast(result.simulated?"示範紀錄，不會發送 LINE":"通知服務已確認送出");await render();}
};
document.addEventListener("click",async e=>{
  const target=e.target.closest("button");if(!target||target.disabled)return;
  try {
    if(target.dataset.view){const view=target.dataset.view;if(["admin","members","notifications"].includes(view)&&state.user.role!=="admin")return;state.view=view;state.status=view==="admin"?"all":view==="board"?"active":"pending";state.query="";state.page=1;await render();}
    else if(target.dataset.status){state.status=target.dataset.status;state.page=1;await render();}
    else if(target.dataset.action){const action=actions[target.dataset.action];if(action)await action(target.dataset.id);}

  } catch(error) {toast(error.message,true);}
});
document.addEventListener("input",e=>{
  if(e.target.id==="taskSearch"){state.query=e.target.value;state.page=1;clearTimeout(state.searchTimer);state.searchTimer=setTimeout(()=>render().catch(err=>toast(err.message,true)),200);}
  if(e.target.closest('form[data-form="create"]')){
    state.requestId=crypto.randomUUID();
    if(e.target.name==="mrn"&&$("#duplicateWarning")){ $("#duplicateWarning").hidden=true;$("#duplicateWarning").innerHTML=""; }
  }
  if(e.target.id==="f-reason"&&$('form[data-form="cancel"]'))$("#f-detail").required=e.target.value==="其他";
});
document.addEventListener("change",e=>{if(e.target.id==="pageSize"){state.pageSize=+e.target.value;state.page=1;render().catch(err=>toast(err.message,true));}if(e.target.id==="editReportToggle"){$("#editReportFields").disabled=!e.target.checked;$("#editReportFields").hidden=!e.target.checked;}});
document.addEventListener("submit",async e=>{
  const form=e.target.closest("form[data-form]");if(!form)return;e.preventDefault();
  const submit=$('button[type="submit"]',form), initial=submit.textContent;submit.disabled=true;submit.textContent="處理中…";
  const type=form.dataset.form,id=form.dataset.id;
  let values=Object.fromEntries(new FormData(form).entries()),message="已儲存";
  try {
    if(type==="create") {values.selfReport=form.dataset.self==="true";values.requestId=state.requestId;if(state.copiedFromTaskId)values.copiedFromTaskId=state.copiedFromTaskId;values.duplicateAcknowledged=values.duplicateAcknowledged==="true";const result=await api("/api/tasks",{method:"POST",body:values});if(result.requiresDuplicateConfirmation){duplicateWarning(result);return;}message=values.selfReport?"已完成回報，施打量已更新":state.copiedFromTaskId?"已建立新任務，原取消紀錄已保留":"已建立待預約任務";}
    else if(type==="member") {values.id=id;values.enabled=values.enabled==="true";await api("/api/users",{method:"POST",body:values});message="已更新團隊成員";}
    else if(type==="import") {const result=await api("/api/import",{method:"POST",body:new FormData(form)});message="新增 "+result.added+" 筆、略過 "+result.skipped+" 筆"+(result.missingCompletionDate?"；"+result.missingCompletionDate+" 筆缺少完成日期":"");}
    else if(type==="announce") {const result=await api("/api/announce",{method:"POST",body:{}});message=result.simulated?"已建立示範通知紀錄，未發送 LINE":"已加入通知佇列，請查看通知紀錄";}
    else {values.version=state.detail.version;values.editReport=values.editReport==="true";const method=type==="edit"?"PUT":type==="remove"?"DELETE":"POST",suffix=["edit","remove"].includes(type)?"":"/"+type;await api("/api/tasks/"+encodeURIComponent(id)+suffix,{method,body:values});message={claim:"已預約施打",performed:"已移至待回報，尚未計入完成施打量",complete:"完成回報已儲存，施打量已更新",cancel:"已取消施打並保留原因",edit:"案件已更新",remove:"案件已移除，操作紀錄已保留"}[type];}
    $("#dialog").close();toast(message);await refresh();
  } catch(error) {toast(error.message,true);}
  finally{submit.disabled=false;submit.textContent=initial;}
});
$("#newTask").addEventListener("click",()=>showCreate());
$("#refresh").addEventListener("click",()=>state.ready?refresh().catch(e=>toast(e.message,true)):window.location.reload());
document.addEventListener("change",e=>{if(e.target.id==="mineMember"){state.mineUserId=e.target.value;state.page=1;render().catch(error=>toast(error.message,true));}});
async function boot(){
  if(window.matchMedia("(max-width:680px)").matches){window.location.replace("/picc-create/");return;}
  decorate();document.querySelectorAll(".nav-link").forEach(button=>{button.disabled=true;});
  try{
    state.config=await api("/api/config");
    if(state.config.loginRequired!==false||!state.config.user?.id)throw new Error("工作站尚未完成啟用，請聯絡管理者。");
    await enter({user:state.config.user,csrf:state.config.csrf||""});state.ready=true;
    document.querySelectorAll(".nav-link").forEach(button=>{button.disabled=false;});$("#newTask").disabled=false;
  }catch(error){
    state.ready=false;$("#newTask").disabled=true;
    $("#mainContent").innerHTML='<section class="panel"><div class="panel-body"><h2>目前無法讀取資料</h2><p class="muted section-spacer">'+esc(error.message)+'</p><p class="muted section-spacer">可使用右上角重新整理，或聯絡管理者完成系統設定。</p></div></section>';
  }
}
boot();
