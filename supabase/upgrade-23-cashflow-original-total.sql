-- Cash flow: a line keeps the amount still to be collected or paid ("amount", shown as Remaining) and an optional original total for reference.
-- Run in the Supabase SQL editor after upgrade-22.
alter table public.cf_items add column if not exists total_amount numeric;

create or replace function public.wbg_cf_save_item(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_id text := nullif(p_row->>'id',''); v_unit text := coalesce(p_row->>'unit','');
  v_name text := trim(coalesce(p_auth->>'name','')); v_kind text := p_row->>'kind'; v_status text := coalesce(nullif(p_row->>'status',''),'open');
  v_bucket int := coalesce(nullif(p_row->>'bucket','')::int, 1); v_total numeric := nullif(p_row->>'total','')::numeric; v_old public.cf_items%rowtype;
begin
  if v_unit = '' or v_kind not in ('in','out') or v_bucket not in (1,2,3) or v_status not in ('open','settled','written_off') then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_id is not null then select * into v_old from public.cf_items where id = v_id; end if;
  if v_old.id is not null and not public.wbg_cf_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  if v_old.id is null then
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    insert into public.cf_items (id, unit_id, kind, party, description, ref, type_code, bucket, amount, total_amount, currency, priority, expected, status, settled_on, note, entered_on, created_by, updated_by)
    values (v_id, v_unit, v_kind, coalesce(p_row->>'party',''), coalesce(p_row->>'description',''), coalesce(p_row->>'ref',''), coalesce(p_row->>'typeCode',''), v_bucket,
      coalesce(nullif(p_row->>'amount','')::numeric, 0), v_total, coalesce(nullif(p_row->>'currency',''),'ETB'), coalesce(nullif(p_row->>'priority',''),'Normal'), nullif(p_row->>'expected','')::date,
      v_status, nullif(p_row->>'settledOn','')::date, coalesce(p_row->>'note',''), coalesce(nullif(p_row->>'enteredOn','')::date, current_date), v_name, v_name);
  else
    update public.cf_items set unit_id = v_unit, kind = v_kind, party = coalesce(p_row->>'party',''), description = coalesce(p_row->>'description',''), ref = coalesce(p_row->>'ref',''),
      type_code = coalesce(p_row->>'typeCode',''), bucket = v_bucket, amount = coalesce(nullif(p_row->>'amount','')::numeric, 0), total_amount = v_total, currency = coalesce(nullif(p_row->>'currency',''),'ETB'),
      priority = coalesce(nullif(p_row->>'priority',''),'Normal'), expected = nullif(p_row->>'expected','')::date, status = v_status, settled_on = nullif(p_row->>'settledOn','')::date,
      note = coalesce(p_row->>'note',''), updated_by = v_name, updated_at = now() where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function public.wbg_cf_save_item(jsonb,jsonb) from public, anon;
grant execute on function public.wbg_cf_save_item(jsonb,jsonb) to authenticated;
