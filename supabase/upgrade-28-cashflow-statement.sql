-- Cash flow, round 4: the weekly plan as the cash flow statement.
-- A week line can now stand on its own (history imported from the old weekly workbooks has no line code yet), keeps the statement row it belongs to,
-- the exchange rate used for USD lines, and the actual that was reported at the time.
-- A movement (cf_log) keeps the exchange rate of the day, so a changing rate never changes earlier values.
-- Run in the Supabase SQL editor after upgrade-27. Safe to run more than once. Schema only, no company data.

alter table public.cf_week_lines alter column item_id drop not null;
alter table public.cf_week_lines add column if not exists stmt text not null default '';          -- row of the cash flow statement, e.g. 'Credit collection'
alter table public.cf_week_lines add column if not exists section text not null default 'operating';
alter table public.cf_week_lines add column if not exists party text not null default '';
alter table public.cf_week_lines add column if not exists description text not null default '';
alter table public.cf_week_lines add column if not exists ref text not null default '';
alter table public.cf_week_lines add column if not exists currency text not null default 'ETB';
alter table public.cf_week_lines add column if not exists rate numeric;                            -- ETB per USD for this line in this week
alter table public.cf_week_lines add column if not exists actual numeric;                          -- actual reported at the time (history only; new weeks are worked out from the daily cash)
alter table public.cf_week_lines add column if not exists remark text not null default '';
alter table public.cf_week_lines add column if not exists source text not null default '';         -- where a history line came from
alter table public.cf_log add column if not exists fx_rate numeric;

create or replace function public.wbg_cf_save_week(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text := coalesce(p_row->>'unit',''); v_name text := trim(coalesce(p_auth->>'name',''));
  v_week date := nullif(p_row->>'week','')::date; v_item public.cf_items%rowtype; v_id text := nullif(p_row->>'id',''); v_iid text := nullif(p_row->>'itemId','');
  v_kind text := p_row->>'kind'; v_old public.cf_week_lines%rowtype;
begin
  if v_unit = '' or v_week is null or extract(dow from v_week) <> 6 then return jsonb_build_object('error','bad_request'); end if;   -- weeks start on a Saturday
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
  insert into public.cf_week_lines (id, unit_id, week, item_id, item_code, kind, planned, due, rolled, note, stmt, section, party, description, ref, currency, rate, remark, created_by, updated_by)
  values (v_id, v_unit, v_week, v_iid, coalesce(v_item.code, ''), v_kind, coalesce(nullif(p_row->>'planned','')::numeric, 0), nullif(p_row->>'due','')::date,
    coalesce((p_row->>'rolled')::boolean, false), coalesce(p_row->>'note',''), coalesce(p_row->>'stmt',''), coalesce(nullif(p_row->>'section',''), v_item.section, 'operating'),
    coalesce(nullif(p_row->>'party',''), v_item.party, ''), coalesce(nullif(p_row->>'description',''), v_item.description, ''), coalesce(nullif(p_row->>'ref',''), v_item.ref, ''),
    coalesce(nullif(p_row->>'currency',''), v_item.currency, 'ETB'), nullif(p_row->>'rate','')::numeric, coalesce(p_row->>'remark',''), v_name, v_name)
  on conflict (id) do update set planned = excluded.planned, due = excluded.due, rolled = excluded.rolled, note = excluded.note, stmt = excluded.stmt, section = excluded.section,
    party = excluded.party, description = excluded.description, ref = excluded.ref, currency = excluded.currency, rate = excluded.rate, remark = excluded.remark, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_cf_save_log(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_id text := nullif(p_row->>'id',''); v_unit text := coalesce(p_row->>'unit',''); v_name text := trim(coalesce(p_auth->>'name',''));
  v_kind text := p_row->>'kind'; v_day date := nullif(p_row->>'day','')::date; v_old public.cf_log%rowtype; v_item text := nullif(p_row->>'itemId','');
  v_code text := coalesce(p_row->>'itemCode',''); v_rate numeric := nullif(p_row->>'fxRate','')::numeric;
begin
  if v_unit = '' or v_day is null or v_kind not in ('in','out') then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_id is not null then select * into v_old from public.cf_log where id = v_id; end if;
  if v_old.id is not null and not public.wbg_cf_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  if v_item is not null then select code into v_code from public.cf_items where id = v_item and unit_id = v_unit; if v_code is null then return jsonb_build_object('error','bad_request'); end if; end if;
  if v_old.id is null then
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    insert into public.cf_log (id, unit_id, day, kind, bank, amount, currency, party, description, type_code, item_id, item_code, note, fx_rate, created_by, updated_by)
    values (v_id, v_unit, v_day, v_kind, coalesce(p_row->>'bank',''), coalesce(nullif(p_row->>'amount','')::numeric,0), coalesce(nullif(p_row->>'currency',''),'ETB'), coalesce(p_row->>'party',''),
      coalesce(p_row->>'description',''), coalesce(p_row->>'typeCode',''), v_item, v_code, coalesce(p_row->>'note',''), v_rate, v_name, v_name);
  else
    update public.cf_log set day = v_day, kind = v_kind, bank = coalesce(p_row->>'bank',''), amount = coalesce(nullif(p_row->>'amount','')::numeric,0), currency = coalesce(nullif(p_row->>'currency',''),'ETB'),
      party = coalesce(p_row->>'party',''), description = coalesce(p_row->>'description',''), type_code = coalesce(p_row->>'typeCode',''), item_id = v_item, item_code = v_code,
      note = coalesce(p_row->>'note',''), fx_rate = v_rate, updated_by = v_name, updated_at = now() where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

revoke all on function public.wbg_cf_save_week(jsonb,jsonb), public.wbg_cf_save_log(jsonb,jsonb) from public, anon;
grant execute on function public.wbg_cf_save_week(jsonb,jsonb), public.wbg_cf_save_log(jsonb,jsonb) to authenticated;
