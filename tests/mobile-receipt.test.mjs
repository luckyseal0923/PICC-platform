import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function page(){
 const nodes=new Map();const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{textContent:'',innerHTML:'',hidden:false,dataset:{},addEventListener(){},focus(){this.focused=true;}});return nodes.get(selector);};
 const context=vm.createContext({document:{body:{dataset:{}},querySelector:node,addEventListener(){}},location:{pathname:'/picc-create/'},URLSearchParams,Intl,ENTRY_ROUTES:{create:'/picc-create/'},entryPage:()=> 'create',createEntryController:()=>({state:{config:{difficulties:[],sites:[],veins:[],catheters:[]}}})});
 const source=readFileSync(new URL('../client/entry.js',import.meta.url),'utf8').replace(/^import[^\n]*\n/,'').replace(/boot\(\);\s*$/,'');
 vm.runInContext(source,context);return {nodes,node,run:expression=>vm.runInContext(expression,context)};
}

test('self-report completion replaces the form, escapes patient text, and displays midnight as 00 rather than 24',()=>{
 const {node,run}=page();
 run(`renderSelfReportComplete({patientName:'<img src=x>',bedNo:'TEST',mrn:'00123456',taskId:'PICC-2610-001',operatorName:'測試甲D',completedAt:'2026-10-25T16:05:00Z'});`);
 const html=node('#entryContent').innerHTML;
 assert.match(html,/起單與施打回報完成/);assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img|<form|改為一般建案/);
 assert.match(html,/00123456/);assert.match(html,/00:05/);assert.doesNotMatch(html,/24:05/);
 assert.equal(node('#pageMessage').hidden,true);assert.equal(node('.completion-card').focused,true);
});

test('the self-report form has no return-to-general-create button while the initial form retains its entry',()=>{
 const {node,run}=page();run('renderCreate()');assert.match(node('#entryContent').innerHTML,/自起單・自回報/);
 run('state.selfReport=true;renderCreate()');const html=node('#entryContent').innerHTML;
 assert.match(html,/送出施打回報/);assert.doesNotMatch(html,/改為一般建案|data-action="toggle-self"/);
});
