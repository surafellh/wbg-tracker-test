-- Cash flow weeks start on a Monday now (they used to start on a Saturday). The weekly save function accepted only Saturdays; accept Mondays.
create or replace function public.wbg_cf_save_week(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text := coalesce(p_row->>'unit',''); v_name text := trim(coalesce(p_auth->>'name',''));
  v_week date := nullif(p_row->>'week','')::date; v_item public.cf_items%rowtype; v_id text := nullif(p_row->>'id',''); v_iid text := nullif(p_row->>'itemId','');
  v_kind text := p_row->>'kind'; v_old public.cf_week_lines%rowtype;
begin
  if v_unit = '' or v_week is null or extract(dow from v_week) <> 1 then return jsonb_build_object('error','bad_request'); end if;   -- weeks start on a Monday
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_iid is not null then
    select * into v_item from public.cf_items where id = v_iid and unit_id = v_unit;
    if v_item.id is null then return jsonb_build_object('error','bad_request'); end if;
    v_kind := v_item.kind; v_id := md5(v_unit || '|' || v_week::text || '|' || v_item.id);
  else
    if v_kind not in ('in','out') then return jsonb_build_object('error','bad_request'); end if;
    if v_id is null then v_id := md5(random()::text || clock_timestamp()::text); end if;
    select * into v_old from public.cf_week_lines where id = v_id;
    if v_old.id is not null and not public.wbg_cf_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  end if;
  insert into public.cf_week_lines (id, unit_id, week, item_id, item_code, kind, planned, due, rolled, note, stmt, section, party, description, ref, currency, rate, remark, actual, created_by, updated_by)
  values (v_id, v_unit, v_week, v_iid, coalesce(v_item.code, ''), v_kind, coalesce(nullif(p_row->>'planned','')::numeric, 0), nullif(p_row->>'due','')::date,
    coalesce((p_row->>'rolled')::boolean, false), coalesce(p_row->>'note',''), coalesce(p_row->>'stmt',''), coalesce(nullif(p_row->>'section',''), v_item.section, 'operating'),
    coalesce(nullif(p_row->>'party',''), v_item.party, ''), coalesce(nullif(p_row->>'description',''), v_item.description, ''), coalesce(nullif(p_row->>'ref',''), v_item.ref, ''),
    coalesce(nullif(p_row->>'currency',''), v_item.currency, 'ETB'), nullif(p_row->>'rate','')::numeric, coalesce(p_row->>'remark',''), nullif(p_row->>'actual','')::numeric, v_name, v_name)
  on conflict (id) do update set planned = excluded.planned, due = excluded.due, rolled = excluded.rolled, note = excluded.note, stmt = excluded.stmt, section = excluded.section,
    party = excluded.party, description = excluded.description, ref = excluded.ref, currency = excluded.currency, rate = excluded.rate, remark = excluded.remark, actual = coalesce(excluded.actual, public.cf_week_lines.actual), updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function public.wbg_cf_save_week(jsonb,jsonb) from public, anon;
grant execute on function public.wbg_cf_save_week(jsonb,jsonb) to authenticated;
