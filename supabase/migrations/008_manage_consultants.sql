-- Manager tools on the Consultants screen: correct a consultant's name/mobile, and delete a
-- consultant (e.g. a duplicate or test registration) together with their reports.

-- Staff: correct name and/or mobile. Snapshots on past reports are left as they were.
create function public.staff_update_consultant(p_consultant_id uuid, p_full_name text, p_mobile text)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  m text;
  c public.consultants;
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  m := public.normalize_mobile(p_mobile);
  if m is null then raise exception 'invalid_mobile'; end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 then raise exception 'invalid_name'; end if;
  if exists (select 1 from public.consultants where mobile = m and id <> p_consultant_id) then
    raise exception 'mobile_taken';
  end if;
  update public.consultants set full_name = left(btrim(p_full_name), 100), mobile = m
   where id = p_consultant_id
  returning * into c;
  if not found then raise exception 'unknown_consultant'; end if;
  return json_build_object('id', c.id, 'full_name', c.full_name, 'mobile', c.mobile);
end $$;

-- Staff: the photo files of a consultant's reports (the dashboard deletes them from Storage
-- before calling delete_consultant, because files cannot be removed from SQL).
create function public.consultant_object_names(p_consultant_id uuid)
returns table (name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  return query
    select o.name
      from public.reports r
      join storage.objects o
        on o.bucket_id = 'report-photos'
       and o.name like private.report_folder(r.id, r.submitted_at) || '/%'
     where r.consultant_id = p_consultant_id;
end $$;

-- Staff: delete a consultant, their reports and photo rows, and their phone links.
create function public.delete_consultant(p_consultant_id uuid)
returns json
language plpgsql security definer set search_path = '' as $$
declare n_reports int;
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  delete from public.reports where consultant_id = p_consultant_id;   -- report_photos cascade
  get diagnostics n_reports = row_count;
  delete from public.consultants where id = p_consultant_id;          -- consultant_devices cascade
  if not found then raise exception 'unknown_consultant'; end if;
  return json_build_object('reports_deleted', n_reports);
end $$;

-- How many reports each consultant has (shown before deleting).
create or replace view public.consultant_overview with (security_invoker = true) as
select c.id, c.full_name, c.mobile, c.created_at, c.is_active, c.allow_new_device,
       (select max(r.submitted_at) from public.reports r where r.consultant_id = c.id) as last_submitted_at,
       (select count(*) from public.consultant_devices d where d.consultant_id = c.id and d.device_hash is not null) as phones,
       (select count(*) from public.reports r where r.consultant_id = c.id) as reports
  from public.consultants c;
revoke all on public.consultant_overview from anon;

revoke execute on function public.staff_update_consultant(uuid, text, text) from public, anon;
revoke execute on function public.consultant_object_names(uuid) from public, anon;
revoke execute on function public.delete_consultant(uuid) from public, anon;
grant execute on function public.staff_update_consultant(uuid, text, text) to authenticated;
grant execute on function public.consultant_object_names(uuid) to authenticated;
grant execute on function public.delete_consultant(uuid) to authenticated;
