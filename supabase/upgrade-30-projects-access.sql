-- Upgrade 30 (test): who can read and edit projects.
-- Read: Group Strategy, CEO / DCEO, the lead executive assistant (LEA), and the Group PMO function (chief, planning head, department heads).
--       A unit's chief / GM / director and planning head read that unit's projects, and projects that list the unit as involved.
--       For Niyat Consultancy the department heads read its projects too (they are business projects).
-- Edit: Group PMO and Group Strategy only.
-- Replaces two functions. No data is changed. Safe to run more than once.

create or replace function public.wbg_project_read(p_unit text, p_involved text[])
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(
       a.j->>'role' in ('super_admin','executive')
    or a.raw = 'lea'
    or (a.j->>'role' in ('leader','planning','manager') and a.j->>'unit' = 'pmo')
    or (a.j->>'role' in ('leader','planning') and (a.j->>'unit' = p_unit or a.j->>'unit' = any(coalesce(p_involved,'{}'))))
    or (a.j->>'role' = 'manager' and p_unit = 'niyat-consultancy' and a.j->>'unit' = p_unit), false)
  from (select public.wbg_auth() as j,
               (select p.role from public.profiles p where p.user_id = auth.uid() and p.status = 'active' and p.setup_done) as raw) a
$$;

create or replace function public.wbg_project_write(p_unit text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(
       a.j->>'role' = 'super_admin'
    or (a.j->>'role' in ('leader','planning','manager') and a.j->>'unit' = 'pmo'), false)
  from (select public.wbg_auth() as j) a
$$;
