// Report queries shared by the list, exports and the archive.
import { CONFIG } from '../config.js?v=7';
import { dayStart, dayEndExclusive, isoDay, mapLimit, fmtIsoDay } from '../lib.js?v=7';
import { sortedPhotos } from './excel.js?v=7';

export const LIST_COLS =
  'id, consultant_id, consultant_name_snapshot, consultant_mobile_snapshot, project_type, project_id, project_other_name, photo_count, photos_expected, submitted_at, projects(name)';
export const FULL_COLS = `${LIST_COLS}, body_html, body_text, report_photos(storage_path, size_bytes, sort_order)`;

/** f: { consultantId, type, project: 'p:<uuid>' | 'o:<name>', from, to } */
export function applyFilters(q, f = {}) {
  if (f.consultantId) q = q.eq('consultant_id', f.consultantId);
  if (f.type) q = q.eq('project_type', f.type);
  if (f.project?.startsWith('p:')) q = q.eq('project_id', f.project.slice(2));
  if (f.project?.startsWith('o:')) q = q.eq('project_other_name', f.project.slice(2)).is('project_id', null);
  if (f.from) q = q.gte('submitted_at', dayStart(f.from));
  if (f.to) q = q.lt('submitted_at', dayEndExclusive(f.to));
  return q;
}

/** Every matching report with body and photo rows, oldest first, fetched in batches. */
export async function fetchAllReports(sb, f, onProgress = () => {}) {
  const BATCH = 200;
  const out = [];
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await applyFilters(sb.from('reports').select(FULL_COLS), f)
      .order('submitted_at', { ascending: true })
      .range(from, from + BATCH - 1);
    if (error) throw error;
    out.push(...data);
    onProgress(out.length);
    if (data.length < BATCH) break;
  }
  return out;
}

/** Downloads a report's photos (in order) as Blobs, with a per-session cache. */
export function photoLoader(sb, cache = null) {
  return async (report) => {
    const photos = sortedPhotos(report);
    return mapLimit(photos, 4, async (p) => {
      if (cache?.has(p.storage_path)) return cache.get(p.storage_path);
      const blob = await downloadWithRetry(sb, p.storage_path);
      cache?.set(p.storage_path, blob);
      return blob;
    });
  };
}

export async function downloadWithRetry(sb, path, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    const { data, error } = await sb.storage.from(CONFIG.PHOTO_BUCKET).download(path);
    if (!error) return data;
    last = error;
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  throw new Error(`photo ${path}: ${last?.message ?? 'download failed'}`);
}

/** File-name range: the filter dates, or the first/last report day. */
export function exportRange(f, reports) {
  const from = f.from ?? (reports.length ? isoDay(reports[0].submitted_at) : null);
  const to = f.to ?? (reports.length ? isoDay(reports[reports.length - 1].submitted_at) : null);
  return { from, to };
}

export function exportBaseName(prefix, { from, to }) {
  return from === to ? `${prefix}_${from}` : `${prefix}_${from}_to_${to}`;
}

/** "Consultant | project type | date range | number of reports" (Section 10.1). */
export function filterParts(f, labels, count, range) {
  const dates = range.from
    ? (range.from === range.to ? fmtIsoDay(range.from) : `${fmtIsoDay(range.from)} – ${fmtIsoDay(range.to)}`)
    : 'All dates';
  return [
    ['Consultant', labels.consultant ?? 'All consultants'],
    ['Project type', f.type ?? 'All types'],
    ...(labels.project ? [['Project', labels.project]] : []),
    ['Dates', dates],
    ['Reports', String(count)],
  ];
}

export function saveBlob(blob, name) {
  window.saveAs(blob, name);
}
