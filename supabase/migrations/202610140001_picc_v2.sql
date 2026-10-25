-- PICC v2: independent Supabase backend. Never modifies old MySQL/n8n records.
-- Execute only in the PICC-booking database, after review and local SQL tests.
begin;
create schema if not exists picc_v2_private;
revoke all on schema picc_v2_private from public, anon, authenticated;

create table if not exists picc_v2_private.members (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id),
  line_user_id text unique,
  name text not null check (length(trim(name)) between 1 and 100),
  role text not null check (role in ('admin','operator')),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
-- The three workflow entries do not verify personal identity. This actor is never a performer.
-- Deploy this shared-entry API only behind the hospital/private-network boundary.
insert into picc_v2_private.members(id,name,role)
values('00000000-0000-4000-8000-000000000001','內部共用入口（未驗證操作者）','operator')
on conflict(id) do nothing;
insert into picc_v2_private.members(id,name,role)
values('00000000-0000-4000-8000-000000000002','內部共用工作站（未驗證操作者）','admin')
on conflict(id) do nothing;
create table if not exists picc_v2_private.tasks (
  id uuid primary key default gen_random_uuid(),
  task_id text not null unique,
  patient_name text not null check (length(trim(patient_name)) between 1 and 100),
  bed_no text not null check (length(trim(bed_no)) between 1 and 100),
  mrn text not null check (length(trim(mrn)) between 1 and 100),
  status text not null check (status in ('pending','claimed','awaiting_report','completed','cancelled')),
  created_at timestamptz not null default now(),
  created_by uuid not null references picc_v2_private.members(id),
  claimed_id uuid references picc_v2_private.members(id),
  claimed_by text, claimed_at timestamptz,
  operator_id uuid references picc_v2_private.members(id),
  operator_name text, completed_at timestamptz,
  difficulty text, insertion_site text, vein text,
  catheter_type text, catheter_length numeric check (catheter_length is null or catheter_length > 0),
  remark text not null default '' check (length(remark)<=1000),
  cancel_reason text, cancel_detail text, cancelled_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1,
  source text not null default 'new',
  reorder_of uuid references picc_v2_private.tasks(id),
  updated_at timestamptz not null default now(),
  check (status<>'cancelled' or (nullif(trim(cancel_reason),'') is not null and cancelled_at is not null))
);
alter table picc_v2_private.tasks drop constraint if exists tasks_status_check;
alter table picc_v2_private.tasks add constraint tasks_status_check
  check (status in ('pending','claimed','awaiting_report','completed','cancelled'));
create index if not exists picc_v2_status_idx on picc_v2_private.tasks(status) where deleted_at is null;
create index if not exists picc_v2_mrn_idx on picc_v2_private.tasks(mrn);
create index if not exists picc_v2_recent_mrn_idx on picc_v2_private.tasks((trim(mrn)),created_at) where deleted_at is null;
create index if not exists picc_v2_completion_idx on picc_v2_private.tasks(completed_at,operator_id);
create table if not exists picc_v2_private.events (
  id bigint generated always as identity primary key,
  task_id uuid references picc_v2_private.tasks(id),
  action text not null,
  actor_id uuid not null references picc_v2_private.members(id),
  actor_name text not null,
  occurred_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb
);
create index if not exists picc_v2_events_idx on picc_v2_private.events(task_id,id);
create table if not exists picc_v2_private.requests (
  actor_id uuid not null references picc_v2_private.members(id),
  request_id text not null,
  payload_hash text not null,
  task_id uuid not null references picc_v2_private.tasks(id),
  primary key(actor_id,request_id)
);

create table if not exists picc_v2_private.case_counters (
  period text primary key,
  last_value bigint not null check (last_value>=0)
);
alter table picc_v2_private.case_counters enable row level security;
alter table picc_v2_private.members enable row level security;
alter table picc_v2_private.tasks enable row level security;
alter table picc_v2_private.events enable row level security;
alter table picc_v2_private.requests enable row level security;
revoke all on all tables in schema picc_v2_private from public, anon, authenticated;
revoke all on all sequences in schema picc_v2_private from public, anon, authenticated;

create or replace function picc_v2_private.next_case_number(p_stamp timestamptz)
returns text language plpgsql volatile security definer set search_path='' as $$
declare period_value text:=to_char(p_stamp at time zone 'Asia/Taipei','YYMM'); existing bigint; sequence_value bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('picc:case-number:'||period_value,0));
  select coalesce(max(substring(task_id from '[0-9]+$')::bigint),0) into existing
    from picc_v2_private.tasks where task_id ~ ('^PICC-'||period_value||'-[0-9]{3,}$');
  insert into picc_v2_private.case_counters(period,last_value) values(period_value,existing+1)
    on conflict(period) do update set last_value=greatest(picc_v2_private.case_counters.last_value,existing)+1
    returning last_value into sequence_value;
  return 'PICC-'||period_value||'-'||lpad(sequence_value::text,greatest(3,length(sequence_value::text)),'0');
end;
$$;
create or replace function picc_v2_private.current_member()
returns picc_v2_private.members
language sql stable security definer set search_path=''
as $$
  select m from picc_v2_private.members m
  where m.auth_user_id=auth.uid() and m.enabled;
$$;
revoke all on function picc_v2_private.current_member() from public,anon,authenticated;

-- No write policies: writes go through the authorized transactional RPC below.
-- RLS remains deny-by-default even if the private schema is accidentally exposed.
create or replace function picc_v2_private.task_json(t picc_v2_private.tasks)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'id',t.id,'taskId',t.task_id,'patientName',t.patient_name,'bedNo',t.bed_no,'mrn',t.mrn,
    'status',t.status,'statusLabel',case t.status when 'pending' then '新開案' when 'claimed' then '待預約'
      when 'awaiting_report' then '施打回報' when 'completed' then '完成' when 'cancelled' then '已取消' end,
    'createdAt',t.created_at,'createdBy',t.created_by,'claimedId',t.claimed_id,'claimedBy',coalesce((select m.name from picc_v2_private.members m where m.id=t.claimed_id),t.claimed_by),
    'claimedAt',t.claimed_at,'operatorId',t.operator_id,'operatorName',coalesce((select m.name from picc_v2_private.members m where m.id=t.operator_id),t.operator_name),'completedAt',t.completed_at,
    'difficulty',t.difficulty,'insertionSite',t.insertion_site,'vein',t.vein,'catheterType',t.catheter_type,
    'catheterLength',t.catheter_length,'remark',t.remark,'cancelReason',t.cancel_reason,
    'cancelDetail',t.cancel_detail,'cancelledAt',t.cancelled_at,'deletedAt',t.deleted_at,
    'version',t.version,'source',t.source,'reorderOf',t.reorder_of,'updatedAt',t.updated_at,
    'hasDifficultHistory',exists(select 1 from picc_v2_private.tasks h where trim(h.mrn)=trim(t.mrn)
      and h.status='completed' and h.deleted_at is null and h.difficulty in ('困難','非常困難'))
  );
$$;
create or replace function picc_v2_private.audit(p_task uuid,p_action text,p_actor picc_v2_private.members,p_detail jsonb)
returns void language sql set search_path='' as $$
  insert into picc_v2_private.events(task_id,action,actor_id,actor_name,detail)
  values(p_task,p_action,p_actor.id,p_actor.name,p_detail);
$$;
create or replace function picc_v2_private.parse_time(p_value text)
returns timestamptz language plpgsql immutable set search_path='' as $$
begin
  if nullif(trim(p_value),'') is null then return null; end if;
  if p_value ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then return p_value::timestamptz; end if;
  return replace(p_value,'/','-')::timestamp at time zone 'Asia/Taipei';
exception when others then raise exception '日期格式不正確，請確認後再試';
end;
$$;
create or replace function picc_v2_private.report(p_data jsonb)
returns jsonb language plpgsql stable set search_path='' as $$
declare op picc_v2_private.members; n numeric;
begin
  select * into op from picc_v2_private.members where id=(p_data->>'operatorId')::uuid and enabled
    and id not in ('00000000-0000-4000-8000-000000000001'::uuid,'00000000-0000-4000-8000-000000000002'::uuid);
  if op.id is null then raise exception '請選擇有效的實際施打者'; end if;
  if coalesce(p_data->>'difficulty','') not in ('非常簡單','簡單','中等','困難','非常困難') then
    raise exception '請選擇放置困難度'; end if;
  if coalesce(p_data->>'insertionSite','') not in ('右上臂','左上臂','左下肢','右下肢','其他') then raise exception '請選擇施打位置'; end if;
  if coalesce(p_data->>'vein','') not in ('Basilic','Cephalic','Brachial') then raise exception '請選擇血管'; end if;
  if coalesce(p_data->>'catheterType','') not in ('雙腔PICC','單腔PICC') then raise exception '請選擇管路類型'; end if;
  n:=nullif(p_data->>'catheterLength','')::numeric;
  if n is not null and (n<=0 or n::text in ('NaN','Infinity','-Infinity')) then raise exception '管路長度須為正數'; end if;
  return jsonb_build_object('operatorId',op.id,'operatorName',op.name,'length',n);
end;
$$;

-- One private engine keeps transitions, version checks and audit in the same transaction.
create or replace function picc_v2_private.api_as(p_actor picc_v2_private.members,p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  actor picc_v2_private.members;
  t picc_v2_private.tasks; original picc_v2_private.tasks;
  op picc_v2_private.members; req picc_v2_private.requests;
  result jsonb; report jsonb; row_data jsonb; before_data jsonb;
  new_id uuid; member_id uuid; stamp timestamptz:=now(); v_request_id text; signature text;
  name_value text; bed_value text; mrn_value text; reason_value text; detail_value text;
  start_date date; end_date date; scope_mine boolean;
  operators jsonb; months jsonb; created_months jsonb; counts jsonb;
  missing integer; added integer:=0; skipped integer:=0; affected integer; row_no integer:=1; duplicate_count integer;
  next_status text; completed_time timestamptz; created_time timestamptz; legacy_operator uuid;
begin
  actor:=p_actor;
  if actor.id is null then raise exception using errcode='42501',message='請先登入並取得 PICC 團隊使用權限'; end if;
  if p_action in ('tasks.edit','tasks.remove','tasks.export','tasks.import','users.save','notifications.list','announce') and actor.role<>'admin' then
    raise exception using errcode='42501',message='此功能限管理者使用';
  end if;
  if jsonb_typeof(p_payload)<>'object' then raise exception '資料格式不正確'; end if;
  if p_action='me' then
    return jsonb_build_object('user',jsonb_build_object('id',actor.id,'name',actor.name,'role',actor.role),'csrf','');
  elsif p_action='users.list' then
    select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'role',m.role,'enabled',case when m.enabled then 1 else 0 end)
      ||case when actor.role='admin' then jsonb_build_object('line_id',m.line_user_id,'auth_user_id',m.auth_user_id) else '{}'::jsonb end
      order by m.role,m.name),'[]'::jsonb) into result from picc_v2_private.members m
      where m.id not in ('00000000-0000-4000-8000-000000000001'::uuid,'00000000-0000-4000-8000-000000000002'::uuid);
    return jsonb_build_object('users',result);
  elsif p_action='users.save' then
    name_value:=trim(p_payload->>'name');
    if coalesce(name_value,'')='' or p_payload->>'role' not in ('admin','operator') then raise exception '請填寫姓名與有效角色'; end if;
    member_id:=coalesce(nullif(p_payload->>'id','')::uuid,gen_random_uuid());
    if member_id in ('00000000-0000-4000-8000-000000000001'::uuid,'00000000-0000-4000-8000-000000000002'::uuid) then
      raise exception '共用入口不是施打成員，無需編輯'; end if;
    if member_id=actor.id and (not coalesce((p_payload->>'enabled')::boolean,true) or p_payload->>'role'<>'admin') then
      raise exception '不能停用或移除自己的管理者權限'; end if;
    if member_id=actor.id and nullif(p_payload->>'authUserId','')::uuid is distinct from actor.auth_user_id then
      raise exception '不能修改自己的登入使用者 ID'; end if;
    insert into picc_v2_private.members(id,auth_user_id,line_user_id,name,role,enabled)
    values(member_id,case when p_payload?'authUserId' then nullif(p_payload->>'authUserId','')::uuid else (select m.auth_user_id from picc_v2_private.members m where m.id=member_id) end,
      case when p_payload?'lineId' then nullif(trim(p_payload->>'lineId'),'') else (select m.line_user_id from picc_v2_private.members m where m.id=member_id) end,name_value,
      p_payload->>'role',coalesce((p_payload->>'enabled')::boolean,true))
    on conflict(id) do update set auth_user_id=excluded.auth_user_id,line_user_id=excluded.line_user_id,
      name=excluded.name,role=excluded.role,enabled=excluded.enabled;
    perform picc_v2_private.audit(null,'member_updated',actor,jsonb_build_object('memberId',member_id,'name',name_value));
    return jsonb_build_object('ok',true);
  elsif p_action in ('tasks.list','tasks.export') then
    start_date:=nullif(p_payload->>'start','')::date; end_date:=nullif(p_payload->>'end','')::date;
    if start_date>end_date then raise exception '開始日期不能晚於結束日期'; end if;
    select coalesce(jsonb_agg(picc_v2_private.task_json(x) order by x.created_at desc),'[]'::jsonb) into result
      from picc_v2_private.tasks x
      where x.deleted_at is null
      and (nullif(p_payload->>'status','') is null or x.status=p_payload->>'status')
      and (not coalesce((p_payload->>'mine')::boolean,false) or x.claimed_id=actor.id or x.operator_id=actor.id)
      and (start_date is null or (x.created_at at time zone 'Asia/Taipei')::date>=start_date)
      and (end_date is null or (x.created_at at time zone 'Asia/Taipei')::date<=end_date)
      and (nullif(p_payload->>'q','') is null or concat_ws(' ',x.patient_name,x.bed_no,x.mrn,x.task_id) ilike '%'||(p_payload->>'q')||'%');
    return jsonb_build_object('tasks',result);
  elsif p_action='stats' then
    start_date:=nullif(p_payload->>'start','')::date; end_date:=nullif(p_payload->>'end','')::date;
    if start_date>end_date then raise exception '開始日期不能晚於結束日期'; end if;
    scope_mine:=actor.role<>'admin' or coalesce(p_payload->>'scope'='mine',false);
    select coalesce(jsonb_agg(to_jsonb(s) order by s.count desc),'[]'::jsonb) into operators from (
      select coalesce(x.operator_id::text,'legacy:'||coalesce(x.operator_name,'')) as "operatorId",
        coalesce(m.name,x.operator_name,'未記錄施打者') as "operatorName",count(*) as count,
        count(*) filter(where x.difficulty in ('困難','非常困難')) as "difficultCount"
      from picc_v2_private.tasks x left join picc_v2_private.members m on m.id=x.operator_id
      where x.status='completed' and x.deleted_at is null and (not scope_mine or x.operator_id=actor.id)
        and (start_date is null or (x.completed_at at time zone 'Asia/Taipei')::date>=start_date)
        and (end_date is null or (x.completed_at at time zone 'Asia/Taipei')::date<=end_date)
      group by 1,2
    ) s;
    select coalesce(jsonb_agg(to_jsonb(s) order by s.month),'[]'::jsonb) into months from (
      select to_char(x.completed_at at time zone 'Asia/Taipei','YYYY-MM') as month,count(*) as count
      from picc_v2_private.tasks x where x.status='completed' and x.deleted_at is null and x.completed_at is not null
        and (not scope_mine or x.operator_id=actor.id)
        and (start_date is null or (x.completed_at at time zone 'Asia/Taipei')::date>=start_date)
        and (end_date is null or (x.completed_at at time zone 'Asia/Taipei')::date<=end_date)
      group by 1
    ) s;
    select coalesce(jsonb_agg(to_jsonb(s) order by s.month),'[]'::jsonb) into created_months from (
      select to_char(created_at at time zone 'Asia/Taipei','YYYY-MM') as month,count(*) as count
      from picc_v2_private.tasks where deleted_at is null group by 1
    ) s;
    select coalesce(jsonb_object_agg(status,n),'{}'::jsonb) into counts from
      (select status,count(*) n from picc_v2_private.tasks where deleted_at is null group by status) s;
    select count(*) into missing from picc_v2_private.tasks where status='completed' and deleted_at is null
      and completed_at is null and (not scope_mine or operator_id=actor.id);
    return jsonb_build_object('operators',operators,'months',months,'createdMonths',created_months,'counts',counts,
      'missingCompletionDate',missing,'totalCompleted',coalesce((select sum((v->>'count')::integer) from jsonb_array_elements(operators) v),0),
      'basis','實際施打者／完成日期（Asia/Taipei）；取消及移除案件不計入');
  elsif p_action='tasks.create' then
    name_value:=trim(p_payload->>'patientName'); bed_value:=trim(p_payload->>'bedNo'); mrn_value:=trim(p_payload->>'mrn');
    v_request_id:=trim(p_payload->>'requestId');
    if coalesce(name_value,'')='' or coalesce(bed_value,'')='' or coalesce(mrn_value,'')='' then raise exception '請填寫病人姓名、床號與病歷號'; end if;
    if coalesce(v_request_id,'')='' or length(v_request_id)>100 then raise exception '送出識別碼不正確'; end if;
    perform pg_advisory_xact_lock(hashtextextended(actor.id::text||':'||v_request_id,0));
    signature:=md5(p_payload::text);
    select * into req from picc_v2_private.requests where actor_id=actor.id and request_id=v_request_id;
    if req.task_id is not null then
      if req.payload_hash<>signature then raise exception '送出識別碼已使用，請重新開啟表單'; end if;
      select * into t from picc_v2_private.tasks where id=req.task_id;
      return jsonb_build_object('ok',true,'duplicate',true,'task',picc_v2_private.task_json(t));
    end if;
    perform pg_advisory_xact_lock(hashtextextended('picc:mrn:'||mrn_value,0));
    select count(*) into duplicate_count from picc_v2_private.tasks
      where trim(mrn)=mrn_value and deleted_at is null
        and created_at>=clock_timestamp()-interval '7 days' and created_at<=clock_timestamp();
    if duplicate_count>0 and not coalesce((p_payload->>'duplicateAcknowledged')::boolean,false) then
      return jsonb_build_object('ok',false,'requiresDuplicateConfirmation',true,'duplicateCount',duplicate_count,
        'error','七日內已有相同病歷號案件，請確認是否重複開單。');
    end if;
    if nullif(p_payload->>'copiedFromTaskId','') is not null then
      select * into original from picc_v2_private.tasks where id=(p_payload->>'copiedFromTaskId')::uuid and deleted_at is null;
      if original.id is null or original.status<>'cancelled' then raise exception '只有已取消案件可重新起單'; end if;
    end if;
    next_status:=case when coalesce((p_payload->>'selfReport')::boolean,false) then 'completed' else 'pending' end;
    if original.id is not null and next_status='completed' then raise exception '重新起單請先建立新開案案件'; end if;
    if next_status='completed' then report:=picc_v2_private.report(p_payload); end if;
    new_id:=gen_random_uuid();
    insert into picc_v2_private.tasks(id,task_id,patient_name,bed_no,mrn,status,created_by,
      operator_id,operator_name,completed_at,difficulty,insertion_site,vein,catheter_type,catheter_length,remark,
      claimed_id,claimed_by,claimed_at,source,reorder_of)
    values(new_id,picc_v2_private.next_case_number(stamp),
      name_value,bed_value,mrn_value,next_status,actor.id,(report->>'operatorId')::uuid,report->>'operatorName',
      case when report is not null then stamp end,p_payload->>'difficulty',p_payload->>'insertionSite',p_payload->>'vein',
      p_payload->>'catheterType',(report->>'length')::numeric,coalesce(p_payload->>'remark',''),
      (report->>'operatorId')::uuid,report->>'operatorName',case when report is not null then stamp end,
      case when original.id is not null then 'reorder' else 'new' end,original.id)
      returning * into t;
    insert into picc_v2_private.requests values(actor.id,v_request_id,signature,new_id);
    perform picc_v2_private.audit(new_id,case when original.id is not null then 'reordered_created'
      when next_status='completed' then 'self_completed' else 'created' end,actor,jsonb_build_object('task',picc_v2_private.task_json(t)));
    if original.id is not null then perform picc_v2_private.audit(original.id,'reordered',actor,jsonb_build_object('newTaskId',t.id,'newTaskNumber',t.task_id)); end if;
    return jsonb_build_object('ok',true,'task',picc_v2_private.task_json(t));
  elsif p_action='tasks.import' then
    if jsonb_typeof(p_payload->'rows')<>'array' or jsonb_array_length(p_payload->'rows')>10000 then raise exception '每次最多匯入 10,000 筆 CSV 資料'; end if;
    for row_data in select value from jsonb_array_elements(p_payload->'rows') loop
      row_no:=row_no+1;
      if nullif(trim(row_data->>'任務編號'),'') is null then raise exception '第 % 列缺少任務編號',row_no; end if;
      if exists(select 1 from picc_v2_private.tasks where task_id=row_data->>'任務編號') then skipped:=skipped+1; continue; end if;
      next_status:=nullif(trim(row_data->>'狀態代碼'),'');
      if next_status is null then
        next_status:=case row_data->>'Status' when '待預約' then 'pending' when '待施打' then 'claimed' when '待回報' then 'awaiting_report'
          when '新開案' then 'pending' when '施打回報' then 'awaiting_report' when '完成' then 'completed' when '已取消' then 'cancelled' end;
      end if;
      if next_status is null or next_status not in ('pending','claimed','awaiting_report','completed','cancelled') then raise exception '第 % 列狀態無法辨識',row_no; end if;
      created_time:=picc_v2_private.parse_time(row_data->>'起單時間');
      if created_time is null then raise exception '第 % 列缺少起單時間',row_no; end if;
      completed_time:=picc_v2_private.parse_time(row_data->>'完成時間');
      select case when count(*)=1 then (array_agg(id))[1] end into legacy_operator
        from picc_v2_private.members where name=trim(row_data->>'施打者')
          and id not in ('00000000-0000-4000-8000-000000000001'::uuid,'00000000-0000-4000-8000-000000000002'::uuid);
      if next_status='completed' and completed_time is null then missing:=coalesce(missing,0)+1; end if;
      insert into picc_v2_private.tasks(task_id,patient_name,bed_no,mrn,status,created_at,created_by,claimed_by,
        operator_id,operator_name,completed_at,difficulty,insertion_site,vein,catheter_type,catheter_length,remark,
        cancel_reason,cancel_detail,cancelled_at,source)
      values(trim(row_data->>'任務編號'),trim(row_data->>'病人姓名'),trim(row_data->>'床號'),trim(row_data->>'病歷號'),
        next_status,created_time,actor.id,trim(row_data->>'接單者'),legacy_operator,trim(row_data->>'施打者'),
        completed_time,trim(row_data->>'困難度'),trim(row_data->>'部位'),trim(row_data->>'血管'),
        trim(row_data->>'管路種類'),nullif(trim(row_data->>'管路長度(cm)'),'')::numeric,coalesce(row_data->>'備註',''),
        trim(row_data->>'取消原因'),trim(row_data->>'取消說明'),picc_v2_private.parse_time(row_data->>'取消時間'),'legacy-import')
        returning * into t;
      perform picc_v2_private.audit(t.id,'imported',actor,jsonb_build_object('taskId',t.task_id,'missingCompletionDate',next_status='completed' and completed_time is null));
      added:=added+1;
    end loop;
    return jsonb_build_object('ok',true,'added',added,'skipped',skipped,'missingCompletionDate',coalesce(missing,0));
  elsif p_action='notifications.list' then return jsonb_build_object('notifications','[]'::jsonb,'deferred',true);
  elsif p_action='announce' then return jsonb_build_object('ok',false,'deferred',true,'error','LINE 通知尚未啟用');
  end if;

  -- All remaining actions are on a single row. Lock it before checking status/version.
  select * into t from picc_v2_private.tasks where id=(p_payload->>'id')::uuid and deleted_at is null for update;
  if t.id is null then raise exception '找不到此案件'; end if;
  if p_action='tasks.get' then
    select coalesce(jsonb_agg(jsonb_build_object('action',e.action,'actorName',e.actor_name,'occurredAt',e.occurred_at,'detail',e.detail) order by e.id desc),'[]'::jsonb)
      into result from picc_v2_private.events e where e.task_id=t.id;
    return jsonb_build_object('task',picc_v2_private.task_json(t),'events',result);
  end if;
  if coalesce((p_payload->>'version')::integer,0)<>t.version then raise exception '案件已被其他人更新，請重新整理後再操作'; end if;
  before_data:=picc_v2_private.task_json(t);
  if p_action='tasks.claim' then
    if t.status<>'pending' then raise exception '此案件已被預約或已結案'; end if;
    select * into op from picc_v2_private.members where id=(p_payload->>'operatorId')::uuid and enabled
      and id not in ('00000000-0000-4000-8000-000000000001'::uuid,'00000000-0000-4000-8000-000000000002'::uuid);
    if op.id is null then raise exception '請選擇有效的預約施打者'; end if;
    update picc_v2_private.tasks set status='claimed',claimed_id=op.id,claimed_by=op.name,claimed_at=stamp,
      updated_at=stamp,version=version+1 where id=t.id and status='pending' and version=t.version returning * into t;
    if not found then raise exception '此案件已被其他人預約'; end if;
    perform picc_v2_private.audit(t.id,'claimed',actor,jsonb_build_object('operatorName',op.name));
  elsif p_action='tasks.performed' then
    if t.status<>'claimed' then raise exception '只有待預約案件可以標記施打回報'; end if;
    update picc_v2_private.tasks set status='awaiting_report',updated_at=stamp,version=version+1
      where id=t.id returning * into t;
    perform picc_v2_private.audit(t.id,'awaiting_report',actor,jsonb_build_object('previousStatus','claimed'));
  elsif p_action='tasks.complete' then
    if t.status not in ('claimed','awaiting_report') then raise exception '只有待預約或施打回報案件可以回報完成'; end if;
    report:=picc_v2_private.report(p_payload);
    update picc_v2_private.tasks set status='completed',operator_id=(report->>'operatorId')::uuid,
      operator_name=report->>'operatorName',completed_at=stamp,difficulty=p_payload->>'difficulty',
      insertion_site=p_payload->>'insertionSite',vein=p_payload->>'vein',catheter_type=p_payload->>'catheterType',
      catheter_length=(report->>'length')::numeric,remark=coalesce(p_payload->>'remark',''),updated_at=stamp,version=version+1
      where id=t.id returning * into t;
    perform picc_v2_private.audit(t.id,'completed',actor,jsonb_build_object('operatorName',t.operator_name));
  elsif p_action='tasks.cancel' then
    if t.status not in ('pending','claimed') then raise exception '只有新開案或待預約案件可以取消'; end if;
    reason_value:=p_payload->>'reason'; detail_value:=trim(coalesce(p_payload->>'detail',''));
    if coalesce(reason_value,'') not in ('暫不需要施打','醫囑調整','病人因素','等待時間過久','其他') or (reason_value='其他' and detail_value='') then
      raise exception '請選擇取消原因；選其他時請補充說明'; end if;
    update picc_v2_private.tasks set status='cancelled',cancel_reason=reason_value,cancel_detail=detail_value,
      cancelled_at=stamp,updated_at=stamp,version=version+1 where id=t.id returning * into t;
    perform picc_v2_private.audit(t.id,'cancelled',actor,jsonb_build_object('reason',reason_value,'detail',detail_value,'previousStatus',before_data->>'status'));
  elsif p_action='tasks.edit' then
    update picc_v2_private.tasks set patient_name=trim(p_payload->>'patientName'),bed_no=trim(p_payload->>'bedNo'),
      mrn=trim(p_payload->>'mrn'),remark=coalesce(p_payload->>'remark',''),updated_at=stamp,version=version+1 where id=t.id;
    if t.status='claimed' and nullif(p_payload->>'claimedId','') is not null then
      select * into op from picc_v2_private.members where id=(p_payload->>'claimedId')::uuid and enabled
        and id not in ('00000000-0000-4000-8000-000000000001'::uuid,'00000000-0000-4000-8000-000000000002'::uuid);
      if op.id is null then raise exception '請選擇有效的接單者'; end if;
      update picc_v2_private.tasks set claimed_id=op.id,claimed_by=op.name where id=t.id;
    end if;
    if t.status='completed' and coalesce((p_payload->>'editReport')::boolean,false) then
      report:=picc_v2_private.report(p_payload);
      update picc_v2_private.tasks set operator_id=(report->>'operatorId')::uuid,operator_name=report->>'operatorName',
        completed_at=case when nullif(p_payload->>'completedAt','') is null then t.completed_at else picc_v2_private.parse_time(p_payload->>'completedAt') end,
        difficulty=p_payload->>'difficulty',insertion_site=p_payload->>'insertionSite',vein=p_payload->>'vein',
        catheter_type=p_payload->>'catheterType',catheter_length=(report->>'length')::numeric where id=t.id;
    end if;
    select * into t from picc_v2_private.tasks where id=t.id;
    perform picc_v2_private.audit(t.id,'edited',actor,jsonb_build_object('before',before_data,'after',picc_v2_private.task_json(t)));
  elsif p_action='tasks.remove' then
    reason_value:=trim(p_payload->>'reason');
    if coalesce(reason_value,'')='' then raise exception '請填寫移除原因'; end if;
    update picc_v2_private.tasks set deleted_at=stamp,updated_at=stamp,version=version+1 where id=t.id returning * into t;
    perform picc_v2_private.audit(t.id,'removed',actor,jsonb_build_object('reason',reason_value,'task',before_data));
  else raise exception '不支援此操作';
  end if;
  return jsonb_build_object('ok',true,'task',picc_v2_private.task_json(t));
end;
$$;
create or replace function public.picc_v2_api(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language sql security definer set search_path='' as $$
  select picc_v2_private.api_as(picc_v2_private.current_member(),p_action,p_payload);
$$;

-- No personal login. Only the three workflow operations are exposed through this wrapper.
-- The public API URL itself does not establish that a caller is on the hospital network.
create or replace function public.picc_v2_entry_api(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare shared_actor picc_v2_private.members;
begin
  select * into shared_actor from picc_v2_private.members
    where id='00000000-0000-4000-8000-000000000001'::uuid and enabled
      and role='operator' and auth_user_id is null;
  if shared_actor.id is null then raise exception '共用入口目前無法使用'; end if;
  if p_action='entry.info' then
    return jsonb_build_object('loginRequired',false,'accessMode','shared','csrf','',
      'user',jsonb_build_object('id',shared_actor.id,'name',shared_actor.name,'role','shared','verified',false));
  end if;
  if p_action not in ('users.list','tasks.list','tasks.get','tasks.create','tasks.claim','tasks.performed','tasks.complete','tasks.cancel') then
    raise exception using errcode='42501',message='共用入口只提供建案、預約與回報操作';
  end if;
  if p_action='tasks.list' and coalesce(p_payload->>'status','') not in ('pending','claimed','awaiting_report') then
    raise exception '請指定新開案或待預約清單'; end if;
  return picc_v2_private.api_as(shared_actor,p_action,p_payload);
end;
$$;
-- The complete desktop workspace is shared within the private hospital network.
-- Do not activate this anonymous management API on an unrestricted public database endpoint.
create or replace function public.picc_v2_workspace_api(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor picc_v2_private.members; result jsonb; existing_role text; clean jsonb:=p_payload;
begin
  select * into actor from picc_v2_private.members where id='00000000-0000-4000-8000-000000000002'::uuid
    and enabled and role='admin' and auth_user_id is null;
  if actor.id is null then raise exception '共用工作站目前無法使用'; end if;
  if p_action='workspace.info' then
    return jsonb_build_object('loginRequired',false,'sharedWorkspace',true,'csrf','',
      'user',jsonb_build_object('id',actor.id,'name',actor.name,'role','admin','verified',false));
  end if;
  if p_action is null or p_action not in ('users.list','users.save','stats','tasks.list','tasks.get','tasks.create',
    'tasks.claim','tasks.performed','tasks.complete','tasks.cancel','tasks.edit','tasks.remove','tasks.export','tasks.import','notifications.list') then
    raise exception '工作站不支援此操作'; end if;
  if p_action='users.save' then
    select m.role into existing_role from picc_v2_private.members m where m.id=nullif(p_payload->>'id','')::uuid;
    clean:=(p_payload-'authUserId'-'lineId')||jsonb_build_object('role',coalesce(existing_role,'operator'));
  end if;
  result:=picc_v2_private.api_as(actor,p_action,clean);
  if p_action='users.list' then
    select coalesce(jsonb_agg(member-'auth_user_id'-'line_id'),'[]'::jsonb) into clean
      from jsonb_array_elements(result->'users') member;
    result:=jsonb_set(result,'{users}',clean);
  end if;
  return result;
end;
$$;
revoke all on all functions in schema picc_v2_private from public,anon,authenticated;
revoke all on function public.picc_v2_api(text,jsonb) from public,anon,authenticated;
grant execute on function public.picc_v2_api(text,jsonb) to authenticated;
revoke all on function public.picc_v2_entry_api(text,jsonb) from public,anon,authenticated;
grant execute on function public.picc_v2_entry_api(text,jsonb) to anon,authenticated;
revoke all on function public.picc_v2_workspace_api(text,jsonb) from public,anon,authenticated;
grant execute on function public.picc_v2_workspace_api(text,jsonb) to anon,authenticated;
comment on function public.picc_v2_api(text,jsonb) is 'PICC v2 authenticated team API. All writes are transactional and audited; LINE notifications are deferred.';
notify pgrst, 'reload schema';
commit;
