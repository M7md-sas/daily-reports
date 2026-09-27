-- Consultants registered before device binding: attach this phone's id to their token on
-- their next visit. If the phone is already bound to a different consultant, refuse.
-- Returns 'unknown' when the token no longer exists (the manager released the phone).
create function public.bind_device(p_consultant_id uuid, p_device_token text, p_device_id text)
returns text
language plpgsql security definer set search_path = '' as $$
declare dev text;
begin
  if length(coalesce(p_device_id, '')) < 16 then raise exception 'device_required'; end if;
  dev := private.hash_token(p_device_id);
  if exists (select 1 from public.consultant_devices
              where device_hash = dev and consultant_id <> p_consultant_id) then
    raise exception 'device_bound_other';
  end if;
  update public.consultant_devices set device_hash = dev
   where consultant_id = p_consultant_id and token_hash = private.hash_token(p_device_token)
     and device_hash is null;
  if exists (select 1 from public.consultant_devices
              where consultant_id = p_consultant_id and token_hash = private.hash_token(p_device_token)) then
    return 'ok';
  end if;
  return 'unknown';
end $$;

revoke execute on function public.bind_device(uuid, text, text) from public;
grant execute on function public.bind_device(uuid, text, text) to anon, authenticated;
