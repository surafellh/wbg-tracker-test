-- Cash flow is for Group Finance only (users of the Group Finance Function unit) and the super admin who looks after the app.
-- The executive, Group Strategy (other than the super admin) and the Finance departments of the business units no longer see it.
-- Every cash flow table and function already asks these five functions, so changing them is enough. Safe to run twice.
create or replace function public.wbg_cf_fin_dept() returns boolean
language sql stable security definer set search_path to 'public' as $$ select false $$;
create or replace function public.wbg_cf_any() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.wbg_auth()->>'role' = 'super_admin' or public.wbg_auth()->>'unit' = 'group-finance-function', false)
$$;
create or replace function public.wbg_cf_read(p_unit text) returns boolean
language sql stable security definer set search_path to 'public' as $$ select public.wbg_cf_any() $$;
create or replace function public.wbg_cf_write(p_unit text) returns boolean
language sql stable security definer set search_path to 'public' as $$ select public.wbg_cf_any() $$;
create or replace function public.wbg_cf_write_any() returns boolean
language sql stable security definer set search_path to 'public' as $$ select public.wbg_cf_any() $$;
