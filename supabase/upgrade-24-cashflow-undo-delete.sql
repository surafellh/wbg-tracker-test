-- Cash flow: deleting a collection / payment line or a cash movement now keeps it (marked deleted) so it can be restored.
-- Run in the Supabase SQL editor after upgrade-23.
alter table public.cf_items add column if not exists deleted_at timestamptz, add column if not exists deleted_by text not null default '';
alter table public.cf_log   add column if not exists deleted_at timestamptz, add column if not exists deleted_by text not null default '';

create or replace function public.wbg_cf_delete(p_auth jsonb, p_table text, p_id text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text; v_name text := trim(coalesce(p_auth->>'name',''));
begin
  if p_table = 'cf_items' then select unit_id into v_unit from public.cf_items where id = p_id;
  elsif p_table = 'cf_plan' then select unit_id into v_unit from public.cf_plan where id = p_id;
  elsif p_table = 'cf_bank' then select unit_id into v_unit from public.cf_bank where id = p_id;
  elsif p_table = 'cf_log' then select unit_id into v_unit from public.cf_log where id = p_id;
  else return jsonb_build_object('error','bad_request'); end if;
  if v_unit is null then return jsonb_build_object('ok', true); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if p_table = 'cf_items' then update public.cf_items set deleted_at = now(), deleted_by = v_name where id = p_id;
  elsif p_table = 'cf_log' then update public.cf_log set deleted_at = now(), deleted_by = v_name where id = p_id;
  elsif p_table = 'cf_plan' then delete from public.cf_plan where id = p_id;
  else delete from public.cf_bank where id = p_id; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wbg_cf_restore(p_auth jsonb, p_table text, p_id text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare p_auth jsonb := public.wbg_auth(); v_unit text;
begin
  if p_table = 'cf_items' then select unit_id into v_unit from public.cf_items where id = p_id;
  elsif p_table = 'cf_log' then select unit_id into v_unit from public.cf_log where id = p_id;
  else return jsonb_build_object('error','bad_request'); end if;
  if v_unit is null then return jsonb_build_object('error','bad_request'); end if;
  if not public.wbg_cf_write(v_unit) then return jsonb_build_object('error','not_allowed'); end if;
  if p_table = 'cf_items' then update public.cf_items set deleted_at = null, deleted_by = '' where id = p_id;
  else update public.cf_log set deleted_at = null, deleted_by = '' where id = p_id; end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.wbg_cf_delete(jsonb,text,text), public.wbg_cf_restore(jsonb,text,text) from public, anon;
grant execute on function public.wbg_cf_delete(jsonb,text,text), public.wbg_cf_restore(jsonb,text,text) to authenticated;
