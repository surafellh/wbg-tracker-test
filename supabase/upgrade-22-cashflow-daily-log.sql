-- Cash flow, round 2: a daily log of what cash really moved (linked to the planned line by a code), and a link code on every planned line.
-- Run in the Supabase SQL editor after upgrade-21.

-- 1. A short code on every collection / payment line (CF-00001 ...). The daily log points to it, so a partial payment is traced to its line.
create sequence if not exists public.cf_item_seq;
alter table public.cf_items add column if not exists code text;
update public.cf_items set code = 'CF-' || lpad(nextval('public.cf_item_seq')::text, 5, '0') where code is null;
alter table public.cf_items alter column code set default ('CF-' || lpad(nextval('public.cf_item_seq')::text, 5, '0'));
create unique index if not exists cf_items_code_uq on public.cf_items(code);

-- 2. The daily log: one row per cash movement, with the bank that was credited or debited.
create table if not exists public.cf_log (
  id text primary key, unit_id text not null, day date not null, kind text not null check (kind in ('in','out')),
  bank text not null default '', amount numeric not null default 0, currency text not null default 'ETB',
  party text not null default '', description text not null default '', type_code text not null default '',
  item_id text, item_code text not null default '', note text not null default '',
  created_by text not null default '', created_at timestamptz not null default now(), updated_by text not null default '', updated_at timestamptz not null default now()
);
create index if not exists cf_log_unit_day_idx on public.cf_log(unit_id, day);
create index if not exists cf_log_item_idx on public.cf_log(item_id);
alter table public.cf_log enable row level security;
drop policy if exists "read" on public.cf_log; create policy "read" on public.cf_log for select to authenticated using (public.wbg_cf_read(unit_id));
revoke all on public.cf_log from anon, authenticated; grant select on public.cf_log to authenticated;

create or replace function public.wbg_cf_save_log(p_auth jsonb, p_row jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_id text := nullif(p_row->>'id',''); v_unit text := coalesce(p_row->>'unit',''); v_name text := trim(coalesce(p_auth->>'name',''));
  v_kind text := p_row->>'kind'; v_day date := nullif(p_row->>'day','')::date; v_old public.cf_log%rowtype; v_item text := nullif(p_row->>'itemId','');
  v_code text := coalesce(p_row->>'itemCode','');
begin
  if v_unit = '' or v_day is null or v_kind not in ('in','out') then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if v_id is not null then select * into v_old from public.cf_log where id = v_id; end if;
  if v_old.id is not null and not public.wbg_cf_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  if v_item is not null then select code into v_code from public.cf_items where id = v_item and unit_id = v_unit; if v_code is null then return jsonb_build_object('error','bad_request'); end if; end if;
  if v_old.id is null then
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    insert into public.cf_log (id, unit_id, day, kind, bank, amount, currency, party, description, type_code, item_id, item_code, note, created_by, updated_by)
    values (v_id, v_unit, v_day, v_kind, coalesce(p_row->>'bank',''), coalesce(nullif(p_row->>'amount','')::numeric,0), coalesce(nullif(p_row->>'currency',''),'ETB'), coalesce(p_row->>'party',''),
      coalesce(p_row->>'description',''), coalesce(p_row->>'typeCode',''), v_item, v_code, coalesce(p_row->>'note',''), v_name, v_name);
  else
    update public.cf_log set day = v_day, kind = v_kind, bank = coalesce(p_row->>'bank',''), amount = coalesce(nullif(p_row->>'amount','')::numeric,0), currency = coalesce(nullif(p_row->>'currency',''),'ETB'),
      party = coalesce(p_row->>'party',''), description = coalesce(p_row->>'description',''), type_code = coalesce(p_row->>'typeCode',''), item_id = v_item, item_code = v_code,
      note = coalesce(p_row->>'note',''), updated_by = v_name, updated_at = now() where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wbg_cf_delete(p_auth jsonb, p_table text, p_id text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text;
begin
  if p_table = 'cf_items' then select unit_id into v_unit from public.cf_items where id = p_id;
  elsif p_table = 'cf_plan' then select unit_id into v_unit from public.cf_plan where id = p_id;
  elsif p_table = 'cf_bank' then select unit_id into v_unit from public.cf_bank where id = p_id;
  elsif p_table = 'cf_log' then select unit_id into v_unit from public.cf_log where id = p_id;
  else return jsonb_build_object('error','bad_request'); end if;
  if v_unit is null then return jsonb_build_object('ok', true); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if p_table = 'cf_items' then delete from public.cf_log where item_id = p_id; delete from public.cf_items where id = p_id;
  elsif p_table = 'cf_plan' then delete from public.cf_plan where id = p_id;
  elsif p_table = 'cf_log' then delete from public.cf_log where id = p_id;
  else delete from public.cf_bank where id = p_id; end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.wbg_cf_save_log(jsonb,jsonb), public.wbg_cf_delete(jsonb,text,text) from public, anon;
grant execute on function public.wbg_cf_save_log(jsonb,jsonb), public.wbg_cf_delete(jsonb,text,text) to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='cf_log') then alter publication supabase_realtime add table public.cf_log; end if;
end $$;
