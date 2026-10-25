"""Prepare a repeatable PICC MySQL import. Reads local exports; never contacts MySQL."""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import re
import uuid
from zoneinfo import ZoneInfo

TAIPEI = ZoneInfo('Asia/Taipei')
WORKSPACE = '00000000-0000-4000-8000-000000000002'
EMPTY = {'', 'undefined', 'null', 'none'}

def clean(value):
    if value is None:
        return None
    text = str(value).strip()
    return None if text.lower() in EMPTY else text

def timestamp(value):
    text = clean(value)
    if not text:
        return None
    date = datetime.fromisoformat(text.replace('Z', '+00:00'))
    if date.tzinfo is None:
        date = date.replace(tzinfo=TAIPEI)
    return date.astimezone(timezone.utc).isoformat(timespec='seconds')

def sql_literal(value):
    return "'" + str(value).replace("'", "''") + "'"

def sql_json(value):
    text = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    tag = '$picc_' + hashlib.sha256(text.encode()).hexdigest()[:20] + '$'
    if tag in text or '\x00' in text:
        raise ValueError('Unsupported SQL data delimiter or null character.')
    return tag + text + tag + '::jsonb'

def normalize(row, source_system):
    original_status = clean(row.get('status'))
    status = {'完成':'completed', '待預約':'pending', '新開案':'pending', '待施打':'claimed', '等候施打':'claimed', '已取消':'cancelled'}.get(original_status)
    if status is None:
        raise ValueError('Unknown legacy state at source ID ' + str(row.get('id')))
    note = str(row.get('remark') or '')
    flags = []
    cancelled = '取消' in note or status == 'cancelled'
    if cancelled and re.search(r'不(?:要|用|需)?取消|未取消|取消後.*(?:完成|成功)|取消失敗', note):
        raise ValueError('Ambiguous cancellation needs review at source ID ' + str(row['id']))
    if cancelled:
        status = 'cancelled'
    created = timestamp(row.get('created_at'))
    completed = timestamp(row.get('completed_at'))
    if not created or not clean(row.get('patient_name')) or not clean(row.get('mrn')):
        raise ValueError('Missing identifying or creation data at source ID ' + str(row['id']))
    if len(note) > 1000:
        raise ValueError('Remark exceeds target limit at source ID ' + str(row['id']))
    reason = detail = cancelled_at = None
    if cancelled:
        # A legacy completion timestamp is the cancellation REPORT time, not an inferred clinical decision time.
        if not completed:
            raise ValueError('Cancellation report timestamp missing at source ID ' + str(row['id']))
        cancelled_at = completed
        cause = re.sub(r'取消(?:施打|置放|放置)?', '', note).strip(' 。．，,;；:：\n\r\t')
        if not cause:
            reason = '未記錄（舊案）'
        elif re.search(r'CVP', cause, re.I):
            reason = '已有／改用其他管路'
        elif cause == '出院':
            reason = '已出院'
        elif cause == '失敗':
            reason = '失敗（舊備註）'
        else:
            # Abbreviations and colloquial statements stay verbatim in detail; do not infer diagnoses.
            reason = '其他'
        detail = '由舊版備註轉為取消；取消時間採原回報時間。原始備註：' + note
        reporter = clean(row.get('operator')) or clean(row.get('completed_by'))
        if reporter:
            detail += '；原填報人：' + reporter
        flags.append('legacy_cancellation_report_time')
        if not cause:
            flags.append('cancellation_reason_missing')
        completed = None
    performer = (clean(row.get('operator')) or clean(row.get('completed_by'))) if status == 'completed' else None
    if status == 'completed' and not performer:
        flags.append('performer_missing')
    if status == 'completed' and not completed:
        flags.append('completion_time_missing')
    clinical = status == 'completed'
    catheter = clean(row.get('catheter_type')) if clinical else None
    if catheter:
        catheter = re.sub(r'^([單雙])腔\s*PICC$', r'\1腔PICC', catheter)
    length = clean(row.get('catheter_length')) if clinical else None
    if length:
        try:
            number = Decimal(length)
            if not number.is_finite() or number <= 0:
                flags.append('invalid_catheter_length_preserved_in_archive')
                length = None
        except InvalidOperation:
            flags.append('invalid_catheter_length_preserved_in_archive')
            length = None
    difficulty = clean(row.get('difficulty')) if clinical else None
    if difficulty and difficulty not in ['非常簡單','簡單','中等','困難','非常困難']:
        flags.append('legacy_difficulty_label_preserved')
    return {
        'id':str(uuid.uuid5(uuid.NAMESPACE_URL, source_system + '/picc_tasks/' + str(row['id']))),
        'taskId':clean(row.get('task_id')), 'patientName':clean(row.get('patient_name')),
        'bedNo':clean(row.get('bed_no')) or '', 'mrn':str(row['mrn']).strip(), 'status':status,
        'createdAt':created, 'claimedBy':clean(row.get('claimed_by')), 'claimedAt':timestamp(row.get('claimed_at')),
        'operatorName':performer, 'completedAt':completed, 'difficulty':difficulty,
        'insertionSite':clean(row.get('insert_site')) if clinical else None,
        'vein':clean(row.get('vessel')) if clinical else None, 'catheterType':catheter,
        'catheterLength':length, 'remark':note, 'cancelReason':reason, 'cancelDetail':detail,
        'cancelledAt':cancelled_at, 'legacyReporter':clean(row.get('operator')) or clean(row.get('completed_by')),
        'flags':flags,
    }

def prepare(rows, raw_sha, source_system):
    if not isinstance(rows, list) or not rows:
        raise ValueError('The source must be a non-empty JSON array.')
    if len({r['id'] for r in rows}) != len(rows) or len({r['task_id'] for r in rows}) != len(rows):
        raise ValueError('Duplicate source IDs or case numbers.')
    items = [{'legacyId':str(r['id']), 'legacyTaskId':str(r['task_id']), 'original':r, 'normalized':normalize(r, source_system)} for r in rows]
    staff = sorted({name for x in items for name in [x['normalized']['operatorName'],x['normalized']['claimedBy']] if name})
    staff_plan = [{'name':name,'id':str(uuid.uuid5(uuid.NAMESPACE_URL, source_system+'/member/'+name))} for name in staff]
    batch = 'MYSQL-PICC-' + raw_sha[:16]
    summary = {'batchId':batch,'sourceSystem':source_system,'sourceSha256':raw_sha,'total':len(items),
        'statusCounts':dict(Counter(x['normalized']['status'] for x in items)), 'staffCount':len(staff),
        'cancellationReasons':dict(Counter(x['normalized']['cancelReason'] for x in items if x['normalized']['status']=='cancelled')),
        'flagCounts':dict(Counter(flag for x in items for flag in x['normalized']['flags'])),
        'sourceCreatedRange':[min(str(r['created_at']) for r in rows),max(str(r['created_at']) for r in rows)],
        'timeInterpretation':'Legacy naive datetime is Asia/Taipei; cancellation timestamp is legacy cancellation report time.',
        'existingSourceDatabaseChanged':False}
    return items, staff_plan, summary

def make_sql(items, staff, summary):
    batch = sql_literal(summary['batchId'])
    source = sql_literal(summary['sourceSystem'])
    count = len(items)
    payload = sql_json(items)
    stage = f'''-- Private archive of the authorized legacy PICC export. No existing cases are altered.
begin;
create table if not exists picc_v2_private.legacy_import_batches(
 batch_id text primary key,source_system text not null,source_sha256 text not null,source_row_count integer not null,
 metadata jsonb not null,created_at timestamptz not null default now(),activated_at timestamptz);
create table if not exists picc_v2_private.legacy_import_rows(
 batch_id text not null references picc_v2_private.legacy_import_batches(batch_id),legacy_id text not null,
 legacy_task_id text not null,target_id uuid not null,original jsonb not null,normalized jsonb not null,
 primary key(batch_id,legacy_id));
alter table picc_v2_private.legacy_import_batches enable row level security;
alter table picc_v2_private.legacy_import_rows enable row level security;
revoke all on picc_v2_private.legacy_import_batches,picc_v2_private.legacy_import_rows from public,anon,authenticated;
insert into picc_v2_private.legacy_import_batches(batch_id,source_system,source_sha256,source_row_count,metadata)
values({batch},{source},{sql_literal(summary['sourceSha256'])},{count},{sql_json(summary)}) on conflict(batch_id) do nothing;
insert into picc_v2_private.legacy_import_rows(batch_id,legacy_id,legacy_task_id,target_id,original,normalized)
select {batch},x->>'legacyId',x->>'legacyTaskId',(x->'normalized'->>'id')::uuid,x->'original',x->'normalized'
from jsonb_array_elements({payload}) x on conflict(batch_id,legacy_id) do nothing;
do $check$ begin
 if (select count(*) from picc_v2_private.legacy_import_rows where batch_id={batch})<>{count} then raise exception 'Legacy archive count mismatch'; end if;
 if (select source_sha256 from picc_v2_private.legacy_import_batches where batch_id={batch})<>{sql_literal(summary['sourceSha256'])} then raise exception 'Legacy archive hash mismatch'; end if;
end $check$;
commit;
select 'legacy archive prepared' as result,count(*) as rows from picc_v2_private.legacy_import_rows where batch_id={batch};
'''
    activation = f'''-- Activate this authorized batch once; preserve all existing tasks and their IDs.
begin;
create temporary table _picc_migration_members(name text primary key,id uuid not null) on commit drop;
do $members$ declare item jsonb; n integer; actual uuid; begin
 for item in select value from jsonb_array_elements({sql_json(staff)}) loop
  select count(*),min(id::text)::uuid into n,actual from picc_v2_private.members
   where trim(name)=item->>'name' and id not in ('{WORKSPACE}'::uuid,'00000000-0000-4000-8000-000000000001'::uuid);
  if n>1 then raise exception 'Duplicate existing staff name requires review'; end if;
  if n=0 then
   actual:=(item->>'id')::uuid;
   insert into picc_v2_private.members(id,name,role,enabled) values(actual,item->>'name','operator',true);
  end if;
  insert into _picc_migration_members values(item->>'name',actual);
 end loop;
end $members$;
do $guard$ begin
 if (select count(*) from picc_v2_private.legacy_import_rows where batch_id={batch})<>{count} then raise exception 'Missing complete source archive'; end if;
 if exists(select 1 from picc_v2_private.legacy_import_rows r join picc_v2_private.tasks t on t.task_id=r.legacy_task_id where r.batch_id={batch} and t.id<>r.target_id) then raise exception 'Legacy case number conflicts with an existing case'; end if;
 if exists(select 1 from picc_v2_private.legacy_import_rows r join picc_v2_private.tasks t on t.id=r.target_id where r.batch_id={batch} and t.source<>{sql_literal('legacy-mysql:'+summary['batchId'])}) then raise exception 'Legacy target ID conflicts with another source'; end if;
end $guard$;
with inserted as (
 insert into picc_v2_private.tasks(id,task_id,patient_name,bed_no,mrn,status,created_at,created_by,
  claimed_id,claimed_by,claimed_at,operator_id,operator_name,completed_at,difficulty,insertion_site,vein,
  catheter_type,catheter_length,remark,cancel_reason,cancel_detail,cancelled_at,source)
 select r.target_id,j->>'taskId',j->>'patientName',j->>'bedNo',j->>'mrn',j->>'status',(j->>'createdAt')::timestamptz,'{WORKSPACE}'::uuid,
  (select id from _picc_migration_members where name=j->>'claimedBy'),j->>'claimedBy',(j->>'claimedAt')::timestamptz,
  (select id from _picc_migration_members where name=j->>'operatorName'),j->>'operatorName',(j->>'completedAt')::timestamptz,
  j->>'difficulty',j->>'insertionSite',j->>'vein',j->>'catheterType',(j->>'catheterLength')::numeric,j->>'remark',
  j->>'cancelReason',j->>'cancelDetail',(j->>'cancelledAt')::timestamptz,{sql_literal('legacy-mysql:'+summary['batchId'])}
 from picc_v2_private.legacy_import_rows r cross join lateral (select r.normalized as j) d
 where r.batch_id={batch} on conflict(id) do nothing returning *
)
insert into picc_v2_private.events(task_id,action,actor_id,actor_name,detail)
select t.id,case when t.status='cancelled' then 'legacy_cancelled_imported' else 'legacy_imported' end,'{WORKSPACE}'::uuid,'舊系統資料移轉',
 jsonb_build_object('reason',case when t.status='cancelled' then t.cancel_reason else '保留原案件編號與原始紀錄' end,
 'detail','原填報人：'||coalesce(r.normalized->>'legacyReporter','未記錄')||case when t.status='cancelled' then '；由原備註轉為取消，時間採原回報時間。' else '' end,
 'batchId',{batch},'legacyId',r.legacy_id,'originalStatus',r.original->>'status','legacyFlags',r.normalized->'flags')
from inserted t join picc_v2_private.legacy_import_rows r on r.target_id=t.id and r.batch_id={batch};
do $verify$ begin
 if (select count(*) from picc_v2_private.tasks t join picc_v2_private.legacy_import_rows r on r.target_id=t.id where r.batch_id={batch})<>{count} then raise exception 'Activated case count mismatch'; end if;
 if exists(select 1 from picc_v2_private.tasks t join picc_v2_private.legacy_import_rows r on r.target_id=t.id where r.batch_id={batch} and (t.status<>r.normalized->>'status' or t.mrn<>r.normalized->>'mrn')) then raise exception 'Activated case state or identifier mismatch'; end if;
end $verify$;
update picc_v2_private.legacy_import_batches set activated_at=coalesce(activated_at,now()) where batch_id={batch};
commit;
select t.status,count(*) as count from picc_v2_private.tasks t join picc_v2_private.legacy_import_rows r on r.target_id=t.id where r.batch_id={batch} group by t.status order by t.status;
'''
    return stage, activation

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--out-dir', required=True, type=Path)
    parser.add_argument('--source-system', default='legacy-picc-mysql')
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    output = args.out_dir.resolve()
    if not output.is_relative_to(project / 'verification'):
        raise SystemExit('Write sensitive exports only under the ignored verification directory.')
    raw = args.source.read_bytes()
    items, staff, summary = prepare(json.loads(raw), hashlib.sha256(raw).hexdigest(), args.source_system)
    output.mkdir(parents=True, exist_ok=True)
    stage, activation = make_sql(items, staff, summary)
    for name, text in [('01-stage.sql',stage),('02-activate.sql',activation),('normalized-cases.json',json.dumps(items,ensure_ascii=False,indent=2)),('migration-summary.json',json.dumps(summary,ensure_ascii=False,indent=2))]:
        (output / name).write_text(text,encoding='utf-8')
    print(json.dumps(summary,ensure_ascii=True,indent=2))

if __name__ == '__main__':
    main()
