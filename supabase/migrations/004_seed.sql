-- Sample projects (one per type). Replace or deactivate them from the dashboard.
insert into public.projects (name, type) values
  ('Sample Cable Route', 'UGC'),
  ('Sample Substation', 'S/S'),
  ('Sample 132kV Line', 'OHTL')
on conflict (name, type) do nothing;
