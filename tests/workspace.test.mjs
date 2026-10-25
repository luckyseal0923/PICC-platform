import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function workspace(){
  const source=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
  assert.match(source,/boot\(\);\s*$/);
  const context=vm.createContext({document:{addEventListener(){},querySelector(){return {addEventListener(){}};}}});
  vm.runInContext(source.replace(/boot\(\);\s*$/,''),context);
  vm.runInContext(`state.user={id:'shared',role:'admin'};state.status='active';state.tasks=['pending','claimed','awaiting_report','completed','cancelled'].map(status=>({id:status,status,patientName:status,bedNo:'TEST',mrn:status,createdAt:new Date().toISOString()}));`,context);
  return expression=>vm.runInContext(expression,context);
}
test('workbench excludes completed and cancelled cases even if a stale historical filter is selected',()=>{
  const run=workspace();assert.equal(run('visibleTasks().length'),3);
  assert.equal(run("state.status='completed';visibleTasks().length"),0);
  assert.equal(run("state.status='all';visibleTasks().length"),3);
  assert.equal(run("state.view='admin';visibleTasks().length"),5);
});
test('full-width workbench retains its three active stages without dashboard cards or a summary sidebar',()=>{
  const run=workspace();const html=run('renderBoard()');
  assert.match(html,/active-workbench/);assert.doesNotMatch(html,/class="metric|<aside|volume-panel|quick-panel/);
  const tabs=run('statusTabs()');for(const status of ['pending','claimed','awaiting_report'])assert.ok(tabs.includes('data-status="'+status+'"'));
  assert.doesNotMatch(tabs,/data-status="(?:completed|cancelled)"/);
  const page=readFileSync(new URL('../static/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(page,/data-view="mine"/);assert.match(page,/>全部案件<\/button>/);
});
