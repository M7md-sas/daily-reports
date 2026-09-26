-- Daily Consultant Reports — Row Level Security, grants and storage

-- ---------------------------------------------------------------- RLS on every table

alter table public.consultants        enable row level security;
alter table public.consultant_devices enable row level security;
alter table public.projects           enable row level security;
alter table public.reports            enable row level security;
alter table public.report_photos      enable row level security;
alter table public.profiles           enable row level security;
alter table public.archive_log        enable row level security;
alter table public.heartbeat          enable row level security;
alter table public.app_settings       enable row level security;

-- consultants: staff read + update (is_active / allow_new_device). Anon: RPC only.
create policy consultants_staff_select on public.consultants
  for select to authenticated using ((select public.is_staff()));
create policy consultants_staff_update on public.consultants
  for update to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

-- consultant_devices: no direct access for anyone (functions only).

-- projects: anon sees active projects only; staff full CRUD.
create policy projects_anon_select on public.projects
  for select to anon using (is_active);
create policy projects_staff_all on public.projects
  for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

-- reports / report_photos: staff select + delete. Anon inserts via submit_report / attach_photos.
create policy reports_staff_select on public.reports
  for select to authenticated using ((select public.is_staff()));
create policy reports_staff_delete on public.reports
  for delete to authenticated using ((select public.is_staff()));
create policy report_photos_staff_select on public.report_photos
  for select to authenticated using ((select public.is_staff()));
create policy report_photos_staff_delete on public.report_photos
  for delete to authenticated using ((select public.is_staff()));

-- profiles: staff read; admin write.
create policy profiles_staff_select on public.profiles
  for select to authenticated using ((select public.is_staff()));
create policy profiles_admin_write on public.profiles
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- archive_log: staff read; staff insert (the manager runs the archive), own user id only.
create policy archive_log_staff_select on public.archive_log
  for select to authenticated using ((select public.is_staff()));
create policy archive_log_staff_insert on public.archive_log
  for insert to authenticated
  with check ((select public.is_staff()) and archived_by = (select auth.uid()));

-- heartbeat: staff read. The keep-alive job updates it through heartbeat_ping().
create policy heartbeat_staff_select on public.heartbeat
  for select to authenticated using ((select public.is_staff()));

-- app_settings: admin only.
create policy app_settings_admin_select on public.app_settings
  for select to authenticated using ((select public.is_admin()));
create policy app_settings_admin_update on public.app_settings
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---------------------------------------------------------------- grants (defence in depth)

revoke all on all tables in schema public from anon;
grant select on public.projects to anon;

revoke all on public.consultant_devices from authenticated;
revoke insert, delete on public.consultants from authenticated;
revoke insert, update on public.reports from authenticated;
revoke insert, update on public.report_photos from authenticated;
revoke update, delete on public.archive_log from authenticated;
revoke insert, update, delete on public.heartbeat from authenticated;
revoke insert, delete on public.app_settings from authenticated;

grant usage on schema private to anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.can_upload_photo(text) to anon, authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.get_public_config() to anon, authenticated;
grant execute on function public.register_consultant(text, text, text) to anon, authenticated;
grant execute on function public.update_my_details(uuid, text, text, text) to anon, authenticated;
grant execute on function public.submit_report(uuid, uuid, text, text, uuid, text, text, text, integer) to anon, authenticated;
grant execute on function public.attach_photos(uuid, uuid, text) to anon, authenticated;
grant execute on function public.heartbeat_ping() to anon, authenticated;
grant execute on function public.normalize_mobile(text) to anon, authenticated;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.other_project_names() to authenticated;
grant execute on function public.promote_other_project(text, text, boolean) to authenticated;
grant execute on function public.storage_usage() to authenticated;
grant execute on function public.archive_object_names(date, date) to authenticated;

-- ---------------------------------------------------------------- storage

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-photos', 'report-photos', false, 1048576, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'];

-- Anon: upload only, and only into the folder of a fresh report (see can_upload_photo).
create policy report_photos_upload on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'report-photos' and private.can_upload_photo(name));

-- Staff: read (signed URLs / download) and delete (archive).
create policy report_photos_staff_read on storage.objects
  for select to authenticated
  using (bucket_id = 'report-photos' and (select public.is_staff()));
create policy report_photos_staff_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'report-photos' and (select public.is_staff()));
