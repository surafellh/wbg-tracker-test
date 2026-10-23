-- Cash flow, round 3: the weekly plan.
-- A planned line (cf_items) keeps its code for life. Each week it is planned again in cf_week_lines (week = the Saturday the week starts),
-- so you can see when it was planned, how much for that week, and trace it week by week. Unpaid lines roll into the next week.
-- Also: a section on each line (operating / investing / financing) and a flag for unplanned cash.
-- Run in the Supabase SQL editor after upgrade-24. Safe to run more than once. Schema only, no company data.

alter table public.cf_items add column if not exists section text not null default 'operating';
alter table public.cf_items add column if not exists unplanned boolean not null default false;
alter table public.cf_items add column if not exists first_week date;

create table if not exists public.cf_week_lines (
  id text primary key, unit_id text not null, week date not null,
  item_id text not null, item_code text not null default '', kind text not null check (kind in ('in','out')),
  planned numeric not null default 0, due date, rolled boolean not null default false, note text not null default '',
  created_by text not null default '', created_at timestamptz not null default now(), updated_by text not null default '', updated_at timestamptz not null default now(),
  unique (unit_id, week, item_id)
);
create index if not exists cf_week_lines_idx on public.cf_week_lines(unit_id, week);
alter table public.cf_week_lines enable row level security;
drop policy if exists "read" on public.cf_week_lines;
create policy "read" on public.cf_week_lines for select to authenticated using (public.wbg_cf_read(unit_id));
revoke all on public.cf_week_lines from anon, authenticated;
grant select on public.cf_week_lines to authenticated;

create or replace function public.wbg_cf_save_item(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_id text := nullif(p_row->>'id',''); v_unit text := coalesce(p_row->>'unit','');
  v_name text := trim(coalesce(p_auth->>'name','')); v_kind text := p_row->>'kind'; v_status text := coalesce(nullif(p_row->>'status',''),'open');
  v_bucket int := coalesce(nullif(p_row->>'bucket','')::int, 1); v_total numeric := nullif(p_row->>'total','')::numeric; v_old public.cf_items%rowtype;
  v_section text := coalesce(nullif(p_row->>'section',''),'operating'); v_unpl boolean := coalesce((p_row->>'unplanned')::boolean, false); v_code text;
begin
  if v_unit = '' or v_kind not in ('in','out') or v_bucket not in (1,2,3) or v_status not in ('open','settled','written_off') or v_section not in ('operating','investing','financing','intercompany','other') then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_id is not null then select * into v_old from public.cf_items where id = v_id; end if;
  if v_old.id is not null and not public.wbg_cf_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  if v_old.id is null then
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    v_code := case when v_unpl then 'UP-' || lpad(nextval('public.cf_item_seq')::text, 5, '0') else 'CF-' || lpad(nextval('public.cf_item_seq')::text, 5, '0') end;
    insert into public.cf_items (id, code, unit_id, kind, party, description, ref, type_code, bucket, amount, total_amount, currency, priority, expected, status, settled_on, note, entered_on, section, unplanned, first_week, created_by, updated_by)
    values (v_id, v_code, v_unit, v_kind, coalesce(p_row->>'party',''), coalesce(p_row->>'description',''), coalesce(p_row->>'ref',''), coalesce(p_row->>'typeCode',''), v_bucket,
      coalesce(nullif(p_row->>'amount','')::numeric, 0), v_total, coalesce(nullif(p_row->>'currency',''),'ETB'), coalesce(nullif(p_row->>'priority',''),'Normal'), nullif(p_row->>'expected','')::date,
      v_status, nullif(p_row->>'settledOn','')::date, coalesce(p_row->>'note',''), coalesce(nullif(p_row->>'enteredOn','')::date, current_date), v_section, v_unpl, nullif(p_row->>'firstWeek','')::date, v_name, v_name);
  else
    update public.cf_items set unit_id = v_unit, kind = v_kind, party = coalesce(p_row->>'party',''), description = coalesce(p_row->>'description',''), ref = coalesce(p_row->>'ref',''),
      type_code = coalesce(p_row->>'typeCode',''), bucket = v_bucket, amount = coalesce(nullif(p_row->>'amount','')::numeric, 0), total_amount = v_total, currency = coalesce(nullif(p_row->>'currency',''),'ETB'),
      priority = coalesce(nullif(p_row->>'priority',''),'Normal'), expected = nullif(p_row->>'expected','')::date, status = v_status, settled_on = nullif(p_row->>'settledOn','')::date,
      note = coalesce(p_row->>'note',''), section = case when p_row ? 'section' then v_section else section end, first_week = coalesce(first_week, nullif(p_row->>'firstWeek','')::date),
      updated_by = v_name, updated_at = now() where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'code', coalesce(v_code, v_old.code));
end $$;

-- One week of one line. planned = what is expected to be collected or paid in that week.
create or replace function public.wbg_cf_save_week(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text := coalesce(p_row->>'unit',''); v_name text := trim(coalesce(p_auth->>'name',''));
  v_week date := nullif(p_row->>'week','')::date; v_item public.cf_items%rowtype; v_id text;
begin
  if v_unit = '' or v_week is null or extract(dow from v_week) <> 6 then return jsonb_build_object('error','bad_request'); end if;   -- weeks start on a Saturday
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  select * into v_item from public.cf_items where id = p_row->>'itemId' and unit_id = v_unit;
  if v_item.id is null then return jsonb_build_object('error','bad_request'); end if;
  insert into public.cf_week_lines (id, unit_id, week, item_id, item_code, kind, planned, due, rolled, note, created_by, updated_by)
  values (md5(v_unit || '|' || v_week::text || '|' || v_item.id), v_unit, v_week, v_item.id, v_item.code, v_item.kind, coalesce(nullif(p_row->>'planned','')::numeric, 0),
    nullif(p_row->>'due','')::date, coalesce((p_row->>'rolled')::boolean, false), coalesce(p_row->>'note',''), v_name, v_name)
  on conflict (unit_id, week, item_id) do update set planned = excluded.planned, due = excluded.due, rolled = excluded.rolled, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_cf_delete(p_auth jsonb, p_table text, p_id text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text; v_name text := trim(coalesce(p_auth->>'name',''));
begin
  if p_table = 'cf_items' then select unit_id into v_unit from public.cf_items where id = p_id;
  elsif p_table = 'cf_plan' then select unit_id into v_unit from public.cf_plan where id = p_id;
  elsif p_table = 'cf_bank' then select unit_id into v_unit from public.cf_bank where id = p_id;
  elsif p_table = 'cf_log' then select unit_id into v_unit from public.cf_log where id = p_id;
  elsif p_table = 'cf_week_lines' then select unit_id into v_unit from public.cf_week_lines where id = p_id;
  else return jsonb_build_object('error','bad_request'); end if;
  if v_unit is null then return jsonb_build_object('ok', true); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if p_table = 'cf_items' then update public.cf_items set deleted_at = now(), deleted_by = v_name where id = p_id;
  elsif p_table = 'cf_log' then update public.cf_log set deleted_at = now(), deleted_by = v_name where id = p_id;
  elsif p_table = 'cf_plan' then delete from public.cf_plan where id = p_id;
  elsif p_table = 'cf_week_lines' then delete from public.cf_week_lines where id = p_id;
  else delete from public.cf_bank where id = p_id; end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.wbg_cf_save_item(jsonb,jsonb), public.wbg_cf_save_week(jsonb,jsonb), public.wbg_cf_delete(jsonb,text,text) from public, anon;
grant execute on function public.wbg_cf_save_item(jsonb,jsonb), public.wbg_cf_save_week(jsonb,jsonb), public.wbg_cf_delete(jsonb,text,text) to authenticated;
