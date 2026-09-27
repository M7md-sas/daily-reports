-- Fixes from the three-way review (lenient / strict / security), 2026-09-27.
--  * Identity: a mobile that is already registered can only be used again from the phone
--    it is bound to (or after the manager taps "Allow new phone") — in every mode.
--    Submitting and attaching photos always require this phone's token.
--  * Registration checks everything else before the team code, and wrong codes are
--    counted (20 per 10 minutes, then rate_limited) so the code cannot be guessed.
--  * Global throttles: 30 new consultants per day, 200 reports per hour, photo storage
--    stops accepting uploads at 950 MB.
--  * Report HTML is checked on the server (allow-listed tags only, 60k characters) and
--    the plain-text version is derived from it on the server.
--  * submit_report is race-safe and tells the phone how many photos the server expects.
--  * Photos may be uploaded for 3 days after the report (was 2).
--  * The mobile number can no longer be changed by the consultant.
--  * Staff can delete only reports from past days (the archive flow).

create table if not exists private.code_failures (at timestamptz not null default now());
create index if not exists code_failures_at_idx on private.code_failures(at);

-- ---------------------------------------------------------------- helpers

create or replace function private.html_ok(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p !~* '<(?!/?(p|br|h1|h2|h3|strong|b|em|i|u|span|ol|ul|li)[\s>/])'
     and p !~* '\son[a-z]+\s*='
     and p !~* 'javascript:'
     and p !~* '<[^>]*\s(src|href|srcset|formaction|xlink)\s*=';
$$;

create or replace function private.html_to_text(p text) returns text
language sql immutable set search_path = '' as $$
  select btrim(
    replace(replace(replace(replace(replace(replace(
      regexp_replace(
        regexp_replace(coalesce(p, ''), '(</(p|li|h1|h2|h3)>|<br\s*/?>)', E'\n', 'gi'),
        '<[^>]*>', '', 'g'),
      '&nbsp;', ' '), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&'),
    E' \n');
$$;

-- ---------------------------------------------------------------- registration

drop function if exists public.register_consultant(text, text, text, text);

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
  -- Everything that does not depend on the code first, so the code cannot be probed cheaply.
  if length(coalesce(p_device_id, '')) < 16 then raise exception 'device_required'; end if;
  dev := private.hash_token(p_device_id);
  m := public.normalize_mobile(p_mobile);
  if m is null then raise exception 'invalid_mobile'; end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 then raise exception 'invalid_name'; end if;

  select * into s from public.app_settings where id = 1;
  if s.access_mode <> 'none' then
    if (select count(*) from private.code_failures where at > now() - interval '10 minutes') >= 20 then
      return json_build_object('error', 'rate_limited');
    end if;
    if s.team_code is null or btrim(coalesce(p_team_code, '')) <> s.team_code then
      insert into private.code_failures default values;  -- kept: we return instead of raising
      return json_build_object('error', 'invalid_team_code');
    end if;
  end if;

  -- One phone = one consultant.
  select id into existing from public.consultants where mobile = m;
  if exists (select 1 from public.consultant_devices d
              where d.device_hash = dev and d.consultant_id is distinct from existing) then
    raise exception 'device_bound_other';
  end if;

  if existing is null then
    if (select count(*) from public.consultants where created_at > now() - interval '1 day') >= 30 then
      raise exception 'rate_limited';
    end if;
    insert into public.consultants (full_name, mobile)
    values (left(btrim(p_full_name), 100), m)
    on conflict (mobile) do nothing
    returning * into c;
    is_new := found;
  end if;

  if not is_new then
    select * into c from public.consultants where mobile = m;
    -- An existing mobile only from its own phone, or after the manager allowed a new phone.
    -- Nothing about the consultant (not even the name) is returned to an unknown phone.
    if not c.allow_new_device
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

-- Name only; the mobile number is the identity and changes go through the manager.
create or replace function public.update_my_details(p_consultant_id uuid, p_device_token text, p_full_name text, p_mobile text)
returns json
language plpgsql security definer set search_path = '' as $$
declare c public.consultants;
begin
  if not private.check_device(p_consultant_id, p_device_token) then
    raise exception 'device_not_recognized';
  end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 then raise exception 'invalid_name'; end if;
  select * into c from public.consultants where id = p_consultant_id;
  if public.normalize_mobile(p_mobile) is distinct from c.mobile then
    raise exception 'mobile_change_manager';
  end if;
  update public.consultants set full_name = left(btrim(p_full_name), 100)
   where id = p_consultant_id
  returning * into c;
  return json_build_object('consultant_id', c.id, 'full_name', c.full_name, 'mobile', c.mobile);
end $$;

-- ---------------------------------------------------------------- submission

create or replace function public.submit_report(
  p_report_id          uuid,
  p_consultant_id      uuid,
  p_device_token       text,
  p_project_type       text,
  p_project_id         uuid,
  p_project_other_name text,
  p_body_html          text,
  p_body_text          text,
  p_photos_expected    integer)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  s          public.app_settings;
  c          public.consultants;
  r          public.reports;
  today_from timestamptz;
  n_today    int;
  existed    boolean := false;
begin
  select * into s from public.app_settings where id = 1;
  select * into c from public.consultants where id = p_consultant_id;
  if not found then raise exception 'unknown_consultant'; end if;
  if not private.check_device(p_consultant_id, p_device_token) then
    raise exception 'device_not_recognized';
  end if;

  select * into r from public.reports where id = p_report_id;
  if found then
    if r.consultant_id <> p_consultant_id then raise exception 'report_conflict'; end if;
    existed := true;
  else
    if p_project_type is null or p_project_type not in ('UGC', 'S/S', 'OHTL') then
      raise exception 'invalid_project_type';
    end if;
    if p_project_id is not null then
      if not exists (select 1 from public.projects
                      where id = p_project_id and is_active and type = p_project_type) then
        raise exception 'invalid_project';
      end if;
      p_project_other_name := null;
    elsif length(btrim(coalesce(p_project_other_name, ''))) = 0 then
      raise exception 'invalid_project';
    end if;
    if length(coalesce(p_body_html, '')) = 0 or length(private.html_to_text(p_body_html)) = 0 then
      raise exception 'empty_report';
    end if;
    if length(p_body_html) > 60000 or not private.html_ok(p_body_html) then
      raise exception 'bad_html';
    end if;
    if coalesce(p_photos_expected, 0) not between 0 and 20 then
      raise exception 'too_many_photos';
    end if;

    today_from := (date_trunc('day', now() at time zone 'Asia/Riyadh')) at time zone 'Asia/Riyadh';
    select count(*) into n_today from public.reports
     where consultant_id = p_consultant_id and submitted_at >= today_from;
    if n_today >= s.max_reports_per_day then raise exception 'daily_limit'; end if;
    if (select count(*) from public.reports where submitted_at > now() - interval '1 hour') >= 200 then
      raise exception 'rate_limited';
    end if;

    insert into public.reports (
      id, consultant_id, consultant_name_snapshot, consultant_mobile_snapshot,
      project_type, project_id, project_other_name, body_html, body_text, photos_expected)
    values (
      p_report_id, c.id, c.full_name, c.mobile,
      p_project_type, p_project_id, nullif(left(btrim(p_project_other_name), 150), ''),
      p_body_html, left(private.html_to_text(p_body_html), 100000), coalesce(p_photos_expected, 0))
    on conflict (id) do nothing
    returning * into r;
    if not found then
      -- A second tap raced us: return what the first one stored.
      select * into r from public.reports where id = p_report_id;
      if r.consultant_id <> p_consultant_id then raise exception 'report_conflict'; end if;
      existed := true;
    end if;
  end if;

  return json_build_object('report_id', r.id, 'submitted_at', r.submitted_at,
                           'folder', private.report_folder(r.id, r.submitted_at),
                           'photos_expected', r.photos_expected, 'existed', existed);
end $$;

create or replace function public.attach_photos(p_report_id uuid, p_consultant_id uuid, p_device_token text)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  r      public.reports;
  folder text;
  cnt    int;
begin
  select * into r from public.reports where id = p_report_id and consultant_id = p_consultant_id;
  if not found then raise exception 'unknown_report'; end if;
  if not private.check_device(p_consultant_id, p_device_token) then
    raise exception 'device_not_recognized';
  end if;

  folder := private.report_folder(r.id, r.submitted_at);
  insert into public.report_photos (report_id, storage_path, size_bytes, sort_order)
  select r.id, o.name, coalesce((o.metadata ->> 'size')::int, 0),
         split_part(split_part(o.name, '/', 5), '.', 1)::int
    from storage.objects o
   where o.bucket_id = 'report-photos'
     and o.name like folder || '/%'
     and split_part(o.name, '/', 5) ~ '^[0-9]{1,2}\.jpg$'
  on conflict do nothing;

  select count(*) into cnt from public.report_photos where report_id = r.id;
  update public.reports set photo_count = cnt where id = r.id;
  return json_build_object('photo_count', cnt, 'photos_expected', r.photos_expected);
end $$;

create or replace function private.can_upload_photo(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  parts text[];
  rid   uuid;
  n     int;
  r     public.reports;
begin
  parts := string_to_array(p_name, '/');
  if array_length(parts, 1) <> 5 or parts[5] !~ '^[0-9]{1,2}\.jpg$' then return false; end if;
  begin
    rid := parts[4]::uuid;
  exception when others then
    return false;
  end;
  select * into r from public.reports where id = rid;
  if not found or r.submitted_at < now() - interval '3 days' then return false; end if;
  if parts[1] || '/' || parts[2] || '/' || parts[3] || '/' || parts[4]
     <> private.report_folder(r.id, r.submitted_at) then
    return false;
  end if;
  n := split_part(parts[5], '.', 1)::int;
  if n not between 1 and r.photos_expected then return false; end if;
  -- Keep a margin below the 1 GB free quota so the project is never restricted.
  return (select coalesce(sum((o.metadata ->> 'size')::bigint), 0)
            from storage.objects o where o.bucket_id = 'report-photos') < 950 * 1024 * 1024;
end $$;

-- ---------------------------------------------------------------- staff

create or replace function public.set_team_code(p_code text)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  s    public.app_settings;
  code text := nullif(btrim(coalesce(p_code, '')), '');
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  select * into s from public.app_settings where id = 1;
  if code is null and s.access_mode <> 'none' then raise exception 'code_required'; end if;
  if code is not null and length(code) not between 6 and 64 then raise exception 'code_length'; end if;
  update public.app_settings set team_code = code where id = 1;
  return json_build_object('team_code', code, 'access_mode', s.access_mode);
end $$;

-- Reports of today cannot be deleted from the dashboard (the archive covers past days only).
drop policy if exists reports_staff_delete on public.reports;
create policy reports_staff_delete on public.reports
  for delete to authenticated
  using ((select public.is_staff())
         and submitted_at < (date_trunc('day', now() at time zone 'Asia/Riyadh') at time zone 'Asia/Riyadh'));

-- Grants for the recreated function (defaults would let PUBLIC execute it).
revoke execute on function public.register_consultant(text, text, text, text) from public;
grant execute on function public.register_consultant(text, text, text, text) to anon, authenticated;
revoke execute on function private.html_ok(text) from public, anon, authenticated;
revoke execute on function private.html_to_text(text) from public, anon, authenticated;
