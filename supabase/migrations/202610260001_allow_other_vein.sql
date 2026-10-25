-- Add the shared "Other" vein option without changing cases or function permissions.
begin;
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
  if coalesce(p_data->>'vein','') not in ('Basilic','Cephalic','Brachial','其他') then raise exception '請選擇血管'; end if;
  if coalesce(p_data->>'catheterType','') not in ('雙腔PICC','單腔PICC') then raise exception '請選擇管路類型'; end if;
  n:=nullif(p_data->>'catheterLength','')::numeric;
  if n is not null and (n<=0 or n::text in ('NaN','Infinity','-Infinity')) then raise exception '管路長度須為正數'; end if;
  return jsonb_build_object('operatorId',op.id,'operatorName',op.name,'length',n);
end;
$$;
commit;
