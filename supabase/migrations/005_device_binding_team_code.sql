-- 1. One phone = one consultant.
--    Every phone keeps a permanent random device id (kept across sign-out). Registering a
--    different consultant from a phone already bound to someone else is refused. The
--    manager can release a phone ("Release phone") when it really changes hands.
-- 2. The manager (not only the admin) can read and change the team access code — nothing else
--    from the admin settings.

alter table public.consultant_devices add column if not exists device_hash text;
create index if not exists consultant_devices_device_hash_idx on public.consultant_devices(device_hash);

drop function if exists public.register_consultant(text, text, text);

create function public.register_consultant(
  p_full_name text, p_mobile text, p_team_code text default null, p_device_id text default null)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  s        public.app_settings;
  m        text;
  c        public.consultants;
  existing uuid;
  dev      text;
  tok      text;
  is_new   boolean := false;
begin
  select * into s from public.app_settings where id = 1;
  if s.access_mode <> 'none'
     and (s.team_code is null or btrim(coalesce(p_team_code, '')) <> s.team_code) then
    raise exception 'invalid_team_code';
  end if;

  if length(coalesce(p_device_id, '')) < 16 then raise exception 'device_required'; end if;
  dev := private.hash_token(p_device_id);

  m := public.normalize_mobile(p_mobile);
  if m is null then raise exception 'invalid_mobile'; end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 then raise exception 'invalid_name'; end if;

  -- This phone already belongs to a different consultant: refuse before creating anything.
  select id into existing from public.consultants where mobile = m;
  if exists (select 1 from public.consultant_devices d
              where d.device_hash = dev and d.consultant_id is distinct from existing) then
    raise exception 'device_bound_other';
  end if;

  insert into public.consultants (full_name, mobile)
  values (left(btrim(p_full_name), 100), m)
  on conflict (mobile) do nothing
  returning * into c;

  if found then
    is_new := true;
  else
    select * into c from public.consultants where mobile = m;
    -- Same phone signing back in to the same consultant is always fine.
    if s.access_mode = 'team_code_device' and not c.allow_new_device
       and not exists (select 1 from public.consultant_devices d
                        where d.consultant_id = c.id and d.device_hash = dev) then
      raise exception 'device_not_allowed';
    end if;
    if c.allow_new_device then
      update public.consultants set allow_new_device = false where id = c.id;
    end if;
  end if;

  tok := private.new_token();
  insert into public.consultant_devices (consultant_id, token_hash, device_hash)
  values (c.id, private.hash_token(tok), dev);

  return json_build_object(
    'consultant_id', c.id, 'full_name', c.full_name, 'mobile', c.mobile,
    'device_token', tok, 'is_new', is_new);
end $$;

-- Changing the mobile number from "Edit my details" must not be a way to take over
-- another consultant's identity on this phone (already blocked by mobile_taken) — unchanged.

-- Manager/admin: free a phone so a different consultant can register on it.
create function public.release_consultant_devices(p_consultant_id uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  delete from public.consultant_devices where consultant_id = p_consultant_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- Manager/admin: read and set the team access code (and nothing else).
create function public.get_team_code()
returns json
language plpgsql stable security definer set search_path = '' as $$
declare s public.app_settings;
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  select * into s from public.app_settings where id = 1;
  return json_build_object('team_code', s.team_code, 'access_mode', s.access_mode);
end $$;

create function public.set_team_code(p_code text)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  s    public.app_settings;
  code text := nullif(btrim(coalesce(p_code, '')), '');
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  select * into s from public.app_settings where id = 1;
  if code is null and s.access_mode <> 'none' then raise exception 'code_required'; end if;
  if code is not null and length(code) not between 4 and 64 then raise exception 'code_length'; end if;
  update public.app_settings set team_code = code where id = 1;
  return json_build_object('team_code', code, 'access_mode', s.access_mode);
end $$;

-- Staff may see which consultant a phone belongs to (never the secret token hash).
grant select (id, consultant_id, device_hash, created_at, last_used_at) on public.consultant_devices to authenticated;
create policy consultant_devices_staff_select on public.consultant_devices
  for select to authenticated using ((select public.is_staff()));

-- How many phones each consultant is bound to (for the Consultants screen).
create or replace view public.consultant_overview with (security_invoker = true) as
select c.id, c.full_name, c.mobile, c.created_at, c.is_active, c.allow_new_device,
       (select max(r.submitted_at) from public.reports r where r.consultant_id = c.id) as last_submitted_at,
       (select count(*) from public.consultant_devices d where d.consultant_id = c.id and d.device_hash is not null) as phones
  from public.consultants c;

revoke execute on function public.register_consultant(text, text, text, text) from public;
grant execute on function public.register_consultant(text, text, text, text) to anon, authenticated;
revoke execute on function public.release_consultant_devices(uuid) from public, anon;
revoke execute on function public.get_team_code() from public, anon;
revoke execute on function public.set_team_code(text) from public, anon;
grant execute on function public.release_consultant_devices(uuid) to authenticated;
grant execute on function public.get_team_code() to authenticated;
grant execute on function public.set_team_code(text) to authenticated;
revoke all on public.consultant_overview from anon;
