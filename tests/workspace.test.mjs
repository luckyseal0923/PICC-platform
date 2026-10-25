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
  assert.match(html,/class="workbench-table"/);assert.match(html,/<th>接單者<\/th>/);
  const dropdown=run('workbenchStatusFilter()');for(const status of ['active','pending','claimed','awaiting_report'])assert.ok(dropdown.includes('value="'+status+'"'));
  assert.doesNotMatch(dropdown,/value="(?:completed|cancelled)"/);
  assert.match(dropdown,/新開案/);assert.match(dropdown,/待預約/);assert.match(dropdown,/施打回報/);
  const page=readFileSync(new URL('../static/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(page,/data-view="mine"/);assert.match(page,/>全部案件<\/button>/);
});
test('booked and report-stage cases have one report action and no extra performed action',()=>{
  const run=workspace();
  for(const status of ['claimed','awaiting_report']){
    const html=run(`taskButtons({id:'test',status:'${status}'})`);
    assert.equal((html.match(/data-action="complete"/g)||[]).length,1);
    assert.doesNotMatch(html,/data-action="performed"/);assert.match(html,/施打回報/);
  }
});
test('outcome rates use closed cases and keep active cases separate',()=>{
  const run=workspace();const result=JSON.parse(run(`JSON.stringify(computeOutcomes([
    {status:'completed',createdAt:'2026-10-01T00:00:00Z',completedAt:'2026-10-02T00:00:00Z'},
    {status:'cancelled',createdAt:'2026-10-01T00:00:00Z',cancelledAt:'2026-10-03T00:00:00Z',cancelReason:'等待時間過久'},
    {status:'pending',createdAt:'2026-10-01T00:00:00Z'},
    {status:'claimed',createdAt:'2026-10-01T00:00:00Z'},
    {status:'awaiting_report',createdAt:'2026-10-01T00:00:00Z'},
    {status:'cancelled',createdAt:'2026-10-01T00:00:00Z',deletedAt:'2026-10-04T00:00:00Z'}
  ]))`));
  assert.equal(result.total,5);assert.equal(result.closed,2);assert.equal(result.active,3);
  assert.equal(result.completionRate,50);assert.equal(result.nonPerformedRate,50);assert.equal(result.cancellationRate,20);
  assert.equal(result.reasons[0].percent,100);assert.equal(result.medianCompletionHours,24);assert.equal(result.medianCancellationHours,48);
});
test('outcome cohorts use Taiwan creation dates and show no final rate for unresolved cohorts',()=>{
  const run=workspace();
  const result=JSON.parse(run(`JSON.stringify(computeOutcomes([{status:'pending',createdAt:'2026-10-01T16:30:00Z'},{status:'completed',createdAt:'2026-10-01T15:30:00Z'}],'2026-10-02','2026-10-02'))`));
  assert.equal(result.total,1);assert.equal(result.active,1);assert.equal(result.completionRate,null);assert.equal(result.nonPerformedRate,null);
  assert.equal(run('computeOutcomes([]).cancellationRate'),null);
});
