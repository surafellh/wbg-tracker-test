-- upgrade-20: Projects follow-up (schema only, no data).
-- Read: super_admin/executive, or leader/planning/manager of the owner unit, an involved unit, or the PMO unit.
-- Write (through the RPC only): super_admin, or leader/planning/manager of the owner unit or the PMO unit.

create table if not exists public.projects (
  id text primary key,
  code text not null default '',
  name text not null,
  type text not null default 'Business',
  unit_id text not null,
  directorate text not null default '',
  sponsor text not null default '',
  manager text not null default '',
  budget numeric,
  start_date date,
  end_date date,
  strategic_link text not null default '',
  status text not null default 'In progress',
  rag text not null default 'Green',
  mode text not null default 'phases',
  involved text[] not null default '{}',
  phases jsonb not null default '[]'::jsonb,
  updates jsonb not null default '[]'::jsonb,
  risks jsonb not null default '[]'::jsonb,
  decisions jsonb not null default '[]'::jsonb,
  notes text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now(),
  updated_by text not null default '',
  updated_at timestamptz not null default now(),
  constraint projects_status_chk check (status in ('Not started','In progress','On hold','Completed','Cancelled')),
  constraint projects_rag_chk check (rag in ('Green','Amber','Red')),
  constraint projects_mode_chk check (mode in ('phases','manual'))
);
create index if not exists projects_unit_idx on public.projects(unit_id);
alter table public.projects enable row level security;

create or replace function public.wbg_project_read(p_unit text, p_involved text[])
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    public.wbg_auth()->>'role' in ('super_admin','executive')
    or (public.wbg_auth()->>'role' in ('leader','planning','manager')
        and (public.wbg_auth()->>'unit' = p_unit
          or public.wbg_auth()->>'unit' = 'pmo'
          or public.wbg_auth()->>'unit' = any(coalesce(p_involved,'{}')))), false)
$$;

create or replace function public.wbg_project_write(p_unit text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    public.wbg_auth()->>'role' = 'super_admin'
    or (public.wbg_auth()->>'role' in ('leader','planning','manager')
        and (public.wbg_auth()->>'unit' = p_unit or public.wbg_auth()->>'unit' = 'pmo')), false)
$$;

drop policy if exists "read" on public.projects;
create policy "read" on public.projects for select to authenticated
  using (public.wbg_project_read(unit_id, involved));

create or replace function public.wbg_save_project(p_auth jsonb, p_row jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  p_auth jsonb := public.wbg_auth();
  v_id text := nullif(p_row->>'id','');
  v_unit text := coalesce(p_row->>'unit','');
  v_name text := trim(coalesce(p_auth->>'name',''));
  v_old public.projects%rowtype;
  v_status text := coalesce(nullif(p_row->>'status',''),'In progress');
  v_rag text := coalesce(nullif(p_row->>'rag',''),'Green');
  v_mode text := coalesce(nullif(p_row->>'mode',''),'phases');
  v_inv text[];
  v_now timestamptz := clock_timestamp();
begin
  if v_unit = '' or trim(coalesce(p_row->>'name','')) = '' then return jsonb_build_object('error','bad_request'); end if;
  if v_status not in ('Not started','In progress','On hold','Completed','Cancelled')
     or v_rag not in ('Green','Amber','Red') or v_mode not in ('phases','manual') then
    return jsonb_build_object('error','bad_request');
  end if;
  if not public.wbg_project_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  select coalesce(array_agg(x), '{}') into v_inv from jsonb_array_elements_text(coalesce(p_row->'involved','[]'::jsonb)) x;
  if v_id is not null then select * into v_old from public.projects where id = v_id; end if;
  if v_old.id is not null then
    if not public.wbg_project_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
    if nullif(p_row->>'updatedAt','') is not null
       and abs(extract(epoch from (v_old.updated_at - (p_row->>'updatedAt')::timestamptz))) > 0.001 then
      return jsonb_build_object('error','conflict');
    end if;
    update public.projects set
      code = coalesce(p_row->>'code',''), name = trim(p_row->>'name'), type = coalesce(nullif(p_row->>'type',''),'Business'),
      unit_id = v_unit, directorate = coalesce(p_row->>'directorate',''), sponsor = coalesce(p_row->>'sponsor',''),
      manager = coalesce(p_row->>'manager',''), budget = nullif(p_row->>'budget','')::numeric,
      start_date = nullif(p_row->>'start','')::date, end_date = nullif(p_row->>'end','')::date,
      strategic_link = coalesce(p_row->>'strategicLink',''), status = v_status, rag = v_rag, mode = v_mode,
      involved = v_inv, phases = coalesce(p_row->'phases','[]'::jsonb), updates = coalesce(p_row->'updates','[]'::jsonb),
      risks = coalesce(p_row->'risks','[]'::jsonb), decisions = coalesce(p_row->'decisions','[]'::jsonb),
      notes = coalesce(p_row->>'notes',''), updated_by = v_name, updated_at = v_now
    where id = v_id;
  else
    v_id := coalesce(v_id, md5(random()::text || clock_timestamp()::text));
    insert into public.projects (id, code, name, type, unit_id, directorate, sponsor, manager, budget, start_date, end_date,
      strategic_link, status, rag, mode, involved, phases, updates, risks, decisions, notes, created_by, updated_by, updated_at)
    values (v_id, coalesce(p_row->>'code',''), trim(p_row->>'name'), coalesce(nullif(p_row->>'type',''),'Business'), v_unit,
      coalesce(p_row->>'directorate',''), coalesce(p_row->>'sponsor',''), coalesce(p_row->>'manager',''),
      nullif(p_row->>'budget','')::numeric, nullif(p_row->>'start','')::date, nullif(p_row->>'end','')::date,
      coalesce(p_row->>'strategicLink',''), v_status, v_rag, v_mode, v_inv, coalesce(p_row->'phases','[]'::jsonb),
      coalesce(p_row->'updates','[]'::jsonb), coalesce(p_row->'risks','[]'::jsonb), coalesce(p_row->'decisions','[]'::jsonb),
      coalesce(p_row->>'notes',''), v_name, v_name, v_now);
  end if;
  perform public.wbg_add_activity(v_name, v_unit, null, jsonb_build_object('action','project',
    'summary', (case when v_old.id is null then 'Added project: ' else 'Updated project: ' end) || left(trim(p_row->>'name'), 120)));
  return jsonb_build_object('ok', true, 'id', v_id, 'updatedAt', v_now);
end $$;

create or replace function public.wbg_delete_project(p_auth jsonb, p_id text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_old public.projects%rowtype;
begin
  select * into v_old from public.projects where id = p_id;
  if v_old.id is null then return jsonb_build_object('ok', true); end if;
  if not public.wbg_project_write(v_old.unit_id) then return jsonb_build_object('error','not_allowed'); end if;
  delete from public.projects where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

revoke all on public.projects from anon, authenticated;
grant select on public.projects to authenticated;
revoke all on function public.wbg_save_project(jsonb, jsonb), public.wbg_delete_project(jsonb, text) from public, anon;
grant execute on function public.wbg_save_project(jsonb, jsonb), public.wbg_delete_project(jsonb, text) to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='projects') then
    alter publication supabase_realtime add table public.projects;
  end if;
end $$;
