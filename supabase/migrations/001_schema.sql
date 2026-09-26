-- Daily Consultant Reports — schema
-- All timestamps are timestamptz; the app displays them in Asia/Riyadh.

create schema if not exists private;

-- ---------------------------------------------------------------- tables

create table public.consultants (
  id               uuid primary key default gen_random_uuid(),
  full_name        text not null check (length(btrim(full_name)) between 2 and 100),
  mobile           text not null unique check (mobile ~ '^\+9665[0-9]{8}$'),
  created_at       timestamptz not null default now(),
  is_active        boolean not null default true,
  -- Used only when access_mode = 'team_code_device': lets an already registered
  -- mobile register once more from a new phone.
  allow_new_device boolean not null default false
);

create table public.consultant_devices (
  id            uuid primary key default gen_random_uuid(),
  consultant_id uuid not null references public.consultants(id) on delete cascade,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index consultant_devices_consultant_idx on public.consultant_devices(consultant_id);

create table public.projects (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 150),
  type       text not null check (type in ('UGC', 'S/S', 'OHTL')),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (name, type)
);

create table public.reports (
  id                         uuid primary key default gen_random_uuid(),
  consultant_id              uuid not null references public.consultants(id) on delete restrict,
  consultant_name_snapshot   text not null,
  consultant_mobile_snapshot text not null,
  project_type               text not null check (project_type in ('UGC', 'S/S', 'OHTL')),
  project_id                 uuid references public.projects(id) on delete restrict,
  project_other_name         text check (project_other_name is null or length(btrim(project_other_name)) between 1 and 150),
  body_html                  text not null check (length(body_html) <= 200000),
  body_text                  text check (body_text is null or length(body_text) <= 100000),
  photos_expected            smallint not null default 0 check (photos_expected between 0 and 20),
  photo_count                smallint not null default 0,
  submitted_at               timestamptz not null default now(),
  constraint reports_one_project check ((project_id is null) <> (project_other_name is null))
);
create index reports_submitted_at_idx on public.reports(submitted_at desc);
create index reports_consultant_idx on public.reports(consultant_id, submitted_at desc);
create index reports_project_idx on public.reports(project_id);

create table public.report_photos (
  id           uuid primary key default gen_random_uuid(),
  report_id    uuid not null references public.reports(id) on delete cascade,
  storage_path text not null unique,
  size_bytes   integer not null default 0,
  sort_order   integer not null,
  unique (report_id, sort_order)
);

create table public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  role         text not null check (role in ('manager', 'admin')),
  display_name text
);

create table public.archive_log (
  id            uuid primary key default gen_random_uuid(),
  range_from    date not null,
  range_to      date not null,
  reports_count integer not null default 0,
  photos_count  integer not null default 0,
  bytes_freed   bigint not null default 0,
  archived_by   uuid default auth.uid() references auth.users(id) on delete set null,
  archived_at   timestamptz not null default now()
);

create table public.heartbeat (
  id        integer primary key default 1 check (id = 1),
  last_ping timestamptz not null default now()
);
insert into public.heartbeat (id) values (1);

create table public.app_settings (
  id                  integer primary key default 1 check (id = 1),
  access_mode         text not null default 'none' check (access_mode in ('none', 'team_code', 'team_code_device')),
  team_code           text,
  max_reports_per_day integer not null default 20 check (max_reports_per_day between 1 and 200)
);
insert into public.app_settings (id) values (1);

-- submitted_at and the consultant snapshot are immutable once written.
create function private.reports_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.submitted_at is distinct from old.submitted_at
     or new.consultant_id is distinct from old.consultant_id
     or new.consultant_name_snapshot is distinct from old.consultant_name_snapshot
     or new.consultant_mobile_snapshot is distinct from old.consultant_mobile_snapshot
     or new.body_html is distinct from old.body_html then
    raise exception 'reports_immutable';
  end if;
  return new;
end $$;

create trigger reports_guard before update on public.reports
for each row execute function private.reports_guard();
