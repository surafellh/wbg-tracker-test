-- Upgrade 16 (TEST ONLY): "View as" for Surafel, with real role permissions and an undo.
-- While viewing as a role, the database treats the session as that role (what it can see and save), exactly like a real user.
-- When viewing starts, a copy of the app data is taken; "Exit and undo my changes" puts that copy back.
-- Not applied to the live project.

create table if not exists public.viewas_session (
  user_id uuid primary key,
  as_role text not null check (as_role in ('executive','leader','planning','manager','staff')),
  as_unit text, as_departments jsonb not null default '[]'::jsonb, started_at timestamptz not null default now());
create table if not exists public.viewas_snapshot (user_id uuid not null, tbl text not null, rows jsonb not null, primary key (user_id, tbl));
alter table public.viewas_session enable row level security;
alter table public.viewas_snapshot enable row level security;

create or replace function public.wbg_auth() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce((select jsonb_build_object('uid', p.user_id, 'name', trim(p.full_name), 'email', p.email,
                          'role', coalesce(v.as_role, public.wbg_base_role(p.role)), 'title', p.title,
                          'unit', case when v.user_id is null then p.unit_id else nullif(v.as_unit,'') end,
                          'departments', case when v.user_id is null then p.departments else v.as_departments end)
                   from public.profiles p left join public.viewas_session v on v.user_id = p.user_id and p.role = 'super_admin'
                   where p.user_id = auth.uid() and p.status = 'active' and p.setup_done), '{}'::jsonb)
$$;

create or replace function public.wbg_viewas_state() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce((select jsonb_build_object('active', true, 'role', as_role, 'unit', coalesce(as_unit,''), 'departments', as_departments)
                   from public.viewas_session where user_id = auth.uid()), jsonb_build_object('active', false))
$$;

create or replace function public.wbg_viewas_start(p_role text, p_unit text, p_depts jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_uid uuid := auth.uid(); v_p public.profiles%rowtype; t text;
begin
  select * into v_p from public.profiles where user_id = v_uid;
  if not found or v_p.role <> 'super_admin' or lower(v_p.email) <> 'surafel.h@wagwagoelectric.com' then return jsonb_build_object('error','not_allowed'); end if;
  if p_role not in ('executive','leader','planning','manager','staff') then return jsonb_build_object('error','bad_request'); end if;
  if not exists (select 1 from public.viewas_session where user_id = v_uid) then
    foreach t in array array['plans','change_requests','activity','ref_counters','feedback','task_comments','task_mentions','support_requests','corrective_actions','units','row_history'] loop
      execute format('insert into public.viewas_snapshot(user_id, tbl, rows) select $1, %L, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x', t, t) using v_uid;
    end loop;
  end if;
  insert into public.viewas_session(user_id, as_role, as_unit, as_departments)
  values (v_uid, p_role, coalesce(p_unit,''), coalesce(p_depts,'[]'::jsonb))
  on conflict (user_id) do update set as_role = excluded.as_role, as_unit = excluded.as_unit, as_departments = excluded.as_departments;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_viewas_stop(p_restore boolean) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_uid uuid := auth.uid(); v_p public.profiles%rowtype; t text; r jsonb;
begin
  select * into v_p from public.profiles where user_id = v_uid;
  if not found or v_p.role <> 'super_admin' or lower(v_p.email) <> 'surafel.h@wagwagoelectric.com' then return jsonb_build_object('error','not_allowed'); end if;
  if p_restore and exists (select 1 from public.viewas_snapshot where user_id = v_uid) then
    foreach t in array array['plans','change_requests','activity','ref_counters','feedback','task_comments','task_mentions','support_requests','corrective_actions','units','row_history'] loop
      select rows into r from public.viewas_snapshot where user_id = v_uid and tbl = t;
      if r is not null then
        execute format('delete from public.%I', t);
        execute format('insert into public.%I select * from jsonb_populate_recordset(null::public.%I, $1)', t, t) using r;
      end if;
    end loop;
  end if;
  delete from public.viewas_session where user_id = v_uid;
  delete from public.viewas_snapshot where user_id = v_uid;
  return jsonb_build_object('ok', true, 'restored', coalesce(p_restore, false));
end $$;

grant execute on function public.wbg_viewas_state() to authenticated;
grant execute on function public.wbg_viewas_start(text, text, jsonb) to authenticated;
grant execute on function public.wbg_viewas_stop(boolean) to authenticated;
