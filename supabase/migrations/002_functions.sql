-- Daily Consultant Reports — functions
-- Consultants (anon) never write to tables directly: every write goes through
-- the SECURITY DEFINER functions below, which validate input first.

-- ---------------------------------------------------------------- helpers

create function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where user_id = (select auth.uid()));
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where user_id = (select auth.uid()) and role = 'admin');
$$;

-- Accepts 05XXXXXXXX, 5XXXXXXXX, +9665XXXXXXXX, 9665XXXXXXXX, 009665XXXXXXXX
-- (spaces, dashes and Arabic-Indic digits allowed). Returns +9665XXXXXXXX or null.
create function public.normalize_mobile(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare d text;
begin
  d := translate(coalesce(p, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
  d := regexp_replace(d, '[\s\-\(\)\.]', '', 'g');
  if d ~ '^05[0-9]{8}$' then return '+966' || substr(d, 2);
  elsif d ~ '^5[0-9]{8}$' then return '+966' || d;
  elsif d ~ '^\+9665[0-9]{8}$' then return d;
  elsif d ~ '^9665[0-9]{8}$' then return '+' || d;
  elsif d ~ '^009665[0-9]{8}$' then return '+' || substr(d, 3);
  end if;
  return null;
end $$;

create function private.hash_token(t text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex');
$$;

create function private.new_token() returns text
language sql volatile set search_path = '' as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

create function private.check_device(p_consultant uuid, p_token text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_token is null or p_token = '' then return false; end if;
  update public.consultant_devices set last_used_at = now()
   where consultant_id = p_consultant and token_hash = private.hash_token(p_token);
  return found;
end $$;

create function private.report_folder(p_id uuid, p_at timestamptz) returns text
language sql immutable set search_path = '' as $$
  select to_char(p_at at time zone 'Asia/Riyadh', 'YYYY/MM/DD') || '/' || p_id::text;
$$;

-- Storage insert policy check: photos may only be uploaded to
-- YYYY/MM/DD/<report_id>/<n>.jpg of an existing report from the last 2 days,
-- with n between 1 and the number of photos the report declared.
create function private.can_upload_photo(p_name text) returns boolean
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
  if not found or r.submitted_at < now() - interval '2 days' then return false; end if;
  if parts[1] || '/' || parts[2] || '/' || parts[3] || '/' || parts[4]
     <> private.report_folder(r.id, r.submitted_at) then
    return false;
  end if;
  n := split_part(parts[5], '.', 1)::int;
  return n between 1 and r.photos_expected;
end $$;

-- ---------------------------------------------------------------- public (consultant) API

create function public.get_public_config() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('access_mode', access_mode) from public.app_settings where id = 1;
$$;

create function public.register_consultant(p_full_name text, p_mobile text, p_team_code text default null)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  s      public.app_settings;
  m      text;
  c      public.consultants;
  tok    text;
  is_new boolean := false;
begin
  select * into s from public.app_settings where id = 1;
  if s.access_mode <> 'none'
     and (s.team_code is null or btrim(coalesce(p_team_code, '')) <> s.team_code) then
    raise exception 'invalid_team_code';
  end if;

  m := public.normalize_mobile(p_mobile);
  if m is null then raise exception 'invalid_mobile'; end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 then raise exception 'invalid_name'; end if;

  insert into public.consultants (full_name, mobile)
  values (left(btrim(p_full_name), 100), m)
  on conflict (mobile) do nothing
  returning * into c;

  if found then
    is_new := true;
  else
    -- Existing mobile: never overwrite the stored name from an unauthenticated call.
    select * into c from public.consultants where mobile = m;
    if s.access_mode = 'team_code_device' and not c.allow_new_device then
      raise exception 'device_not_allowed';
    end if;
    if c.allow_new_device then
      update public.consultants set allow_new_device = false where id = c.id;
    end if;
  end if;

  tok := private.new_token();
  insert into public.consultant_devices (consultant_id, token_hash)
  values (c.id, private.hash_token(tok));

  return json_build_object(
    'consultant_id', c.id, 'full_name', c.full_name, 'mobile', c.mobile,
    'device_token', tok, 'is_new', is_new);
end $$;

create function public.update_my_details(p_consultant_id uuid, p_device_token text, p_full_name text, p_mobile text)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  m text;
  c public.consultants;
begin
  if not private.check_device(p_consultant_id, p_device_token) then
    raise exception 'device_not_recognized';
  end if;
  m := public.normalize_mobile(p_mobile);
  if m is null then raise exception 'invalid_mobile'; end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 then raise exception 'invalid_name'; end if;
  if exists (select 1 from public.consultants where mobile = m and id <> p_consultant_id) then
    raise exception 'mobile_taken';
  end if;
  update public.consultants set full_name = left(btrim(p_full_name), 100), mobile = m
   where id = p_consultant_id
  returning * into c;
  return json_build_object('consultant_id', c.id, 'full_name', c.full_name, 'mobile', c.mobile);
end $$;

-- Idempotent: the client generates p_report_id, so a retry after a network
-- failure returns the already-created report instead of a duplicate.
create function public.submit_report(
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
  tok_ok     boolean;
  today_from timestamptz;
  n_today    int;
begin
  select * into s from public.app_settings where id = 1;
  select * into c from public.consultants where id = p_consultant_id;
  if not found then raise exception 'unknown_consultant'; end if;

  tok_ok := private.check_device(p_consultant_id, p_device_token);
  if s.access_mode = 'team_code_device' and not tok_ok then
    raise exception 'device_not_recognized';
  end if;

  select * into r from public.reports where id = p_report_id;
  if found then
    if r.consultant_id <> p_consultant_id then raise exception 'report_conflict'; end if;
    return json_build_object('report_id', r.id, 'submitted_at', r.submitted_at,
                             'folder', private.report_folder(r.id, r.submitted_at));
  end if;

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
  if length(btrim(coalesce(p_body_text, ''))) = 0 or length(coalesce(p_body_html, '')) = 0 then
    raise exception 'empty_report';
  end if;
  if coalesce(p_photos_expected, 0) not between 0 and 20 then
    raise exception 'too_many_photos';
  end if;

  today_from := (date_trunc('day', now() at time zone 'Asia/Riyadh')) at time zone 'Asia/Riyadh';
  select count(*) into n_today from public.reports
   where consultant_id = p_consultant_id and submitted_at >= today_from;
  if n_today >= s.max_reports_per_day then raise exception 'daily_limit'; end if;

  insert into public.reports (
    id, consultant_id, consultant_name_snapshot, consultant_mobile_snapshot,
    project_type, project_id, project_other_name, body_html, body_text, photos_expected)
  values (
    p_report_id, c.id, c.full_name, c.mobile,
    p_project_type, p_project_id, nullif(left(btrim(p_project_other_name), 150), ''),
    p_body_html, p_body_text, coalesce(p_photos_expected, 0))
  returning * into r;

  return json_build_object('report_id', r.id, 'submitted_at', r.submitted_at,
                           'folder', private.report_folder(r.id, r.submitted_at));
end $$;

-- Registers the photos that actually exist in storage for this report.
-- Sizes come from storage metadata, not from the client.
create function public.attach_photos(p_report_id uuid, p_consultant_id uuid, p_device_token text)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  s      public.app_settings;
  r      public.reports;
  folder text;
  cnt    int;
begin
  select * into s from public.app_settings where id = 1;
  select * into r from public.reports where id = p_report_id and consultant_id = p_consultant_id;
  if not found then raise exception 'unknown_report'; end if;
  if not private.check_device(p_consultant_id, p_device_token) and s.access_mode = 'team_code_device' then
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

create function public.heartbeat_ping() returns timestamptz
language sql security definer set search_path = '' as $$
  update public.heartbeat set last_ping = now() where id = 1 returning last_ping;
$$;

-- ---------------------------------------------------------------- staff API

create function public.other_project_names()
returns table (project_type text, name text, report_count bigint, last_used timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  return query
    select r.project_type, r.project_other_name, count(*), max(r.submitted_at)
      from public.reports r
     where r.project_id is null
     group by r.project_type, r.project_other_name
     order by max(r.submitted_at) desc;
end $$;

create function public.promote_other_project(p_type text, p_name text, p_relink boolean)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  pid     uuid;
  relinked int := 0;
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  insert into public.projects (name, type) values (btrim(p_name), p_type)
  on conflict (name, type) do update set is_active = true
  returning id into pid;
  if p_relink then
    update public.reports set project_id = pid, project_other_name = null
     where project_id is null and project_type = p_type and project_other_name = p_name;
    get diagnostics relinked = row_count;
  end if;
  return json_build_object('project_id', pid, 'relinked', relinked);
end $$;

create function public.storage_usage() returns json
language plpgsql stable security definer set search_path = '' as $$
declare res json;
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  select json_build_object(
    'photos_bytes', coalesce(sum((o.metadata ->> 'size')::bigint), 0),
    'photos_count', count(*),
    'db_bytes', pg_database_size(current_database()))
    into res
    from storage.objects o where o.bucket_id = 'report-photos';
  return res;
end $$;

-- Every storage object whose date folder falls in the range (includes any
-- orphaned uploads that never got attached to a report).
create function public.archive_object_names(p_from date, p_to date)
returns table (name text, size_bytes bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  return query
    select o.name, coalesce((o.metadata ->> 'size')::bigint, 0)
      from storage.objects o
     where o.bucket_id = 'report-photos'
       and o.name ~ '^[0-9]{4}/[0-9]{2}/[0-9]{2}/'
       and to_date(substr(o.name, 1, 10), 'YYYY/MM/DD') between p_from and p_to
     order by o.name;
end $$;

create view public.consultant_overview with (security_invoker = true) as
select c.id, c.full_name, c.mobile, c.created_at, c.is_active, c.allow_new_device,
       (select max(r.submitted_at) from public.reports r where r.consultant_id = c.id) as last_submitted_at
  from public.consultants c;
