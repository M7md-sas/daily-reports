// Archive (Section 12.2): build the ZIP in the browser, then — only after the manager
// confirms — delete the storage objects and database rows for the range.
import { CONFIG } from '../config.js';
import { isoDay, addDays } from '../lib.js';
import { fetchAllReports, photoLoader, exportBaseName, filterParts } from './data.js';
import { buildPdf } from './pdf.js';
import { buildExcel, assignPhotoNames, sortedPhotos } from './excel.js';

/** Counts, size and the split into ZIP parts for a date range. */
export async function planArchive(sb, from, to) {
  const perDay = new Map();
  let reports = 0;
  const BATCH = 1000;
  for (let i = 0; ; i += BATCH) {
    const { data, error } = await sb.from('reports')
      .select('submitted_at, report_photos(size_bytes)')
      .gte('submitted_at', `${from}T00:00:00${CONFIG.UTC_OFFSET}`)
      .lt('submitted_at', `${addDays(to, 1)}T00:00:00${CONFIG.UTC_OFFSET}`)
      .order('submitted_at')
      .range(i, i + BATCH - 1);
    if (error) throw error;
    for (const r of data) {
      const d = isoDay(r.submitted_at);
      const bytes = r.report_photos.reduce((s, p) => s + (p.size_bytes ?? 0), 0);
      perDay.set(d, (perDay.get(d) ?? 0) + bytes + 20000); // + rough PDF share per report
    }
    reports += data.length;
    if (data.length < BATCH) break;
  }

  const { data: objects, error } = await sb.rpc('archive_object_names', { p_from: from, p_to: to });
  if (error) throw error;
  const bytes = objects.reduce((s, o) => s + Number(o.size_bytes ?? 0), 0);

  // Greedy split by whole days so each ZIP stays under ARCHIVE_PART_BYTES.
  const parts = [];
  let cur = null;
  for (const [day, b] of [...perDay.entries()].sort()) {
    if (cur && cur.bytes + b > CONFIG.ARCHIVE_PART_BYTES) {
      parts.push(cur);
      cur = null;
    }
    cur ??= { from: day, to: day, bytes: 0 };
    cur.to = day;
    cur.bytes += b;
  }
  if (cur) parts.push(cur);
  // The first/last part cover the whole requested range (days without reports included).
  if (parts.length) {
    parts[0].from = from;
    parts[parts.length - 1].to = to;
  }
  return { from, to, reports, photos: objects.length, bytes, parts };
}

/**
 * Builds one archive ZIP. Throws on any failure (nothing is deleted by this function).
 * onProgress(fraction, stage) — stage: 'photos' | 'pdf' | 'zip'
 */
export async function buildArchivePart(sb, part, onProgress = () => {}) {
  const f = { from: part.from, to: part.to };
  const reports = await fetchAllReports(sb, f);
  const cache = new Map();
  const load = photoLoader(sb, cache);

  // 1. Download every photo first — if any is missing the archive fails before we go on.
  for (let i = 0; i < reports.length; i++) {
    await load(reports[i]);
    onProgress(0.45 * ((i + 1) / reports.length), 'photos');
  }

  const range = { from: part.from, to: part.to };
  const base = exportBaseName('Daily_Reports', range);
  const names = assignPhotoNames(reports);

  // 2. PDF + Excel of the same reports.
  const pdf = await buildPdf({
    reports,
    filterParts: filterParts(f, {}, reports.length, range),
    loadPhotos: load,
    onProgress: (d, n) => onProgress(0.45 + 0.4 * (d / n), 'pdf'),
  });
  const xlsx = buildExcel(reports, names);

  // 3. ZIP (photos are already JPEG, so store without re-compressing).
  const zip = new window.JSZip();
  zip.file(`${base}.pdf`, pdf);
  zip.file(`${base}.xlsx`, xlsx);
  for (const r of reports) {
    for (const p of sortedPhotos(r)) zip.file(names.get(p.storage_path), cache.get(p.storage_path));
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true },
    (meta) => onProgress(0.85 + 0.15 * (meta.percent / 100), 'zip'));
  cache.clear();
  return { blob, name: `${exportBaseName('Archive', range)}.zip`, reports: reports.length };
}

/**
 * Deletes storage objects, then report rows, for the range. Safe to run again after
 * an interruption: it simply continues with whatever is left.
 */
export async function deleteRange(sb, from, to, onProgress = () => {}) {
  const { data: objects, error } = await sb.rpc('archive_object_names', { p_from: from, p_to: to });
  if (error) throw error;
  const names = objects.map((o) => o.name);
  const CHUNK = 100;
  for (let i = 0; i < names.length; i += CHUNK) {
    const { data: removed, error: e } = await sb.storage.from(CONFIG.PHOTO_BUCKET).remove(names.slice(i, i + CHUNK));
    if (e) throw e;
    if (!removed?.length) throw new Error('photos could not be deleted (permission denied)');
    onProgress(0.7 * Math.min(1, (i + CHUNK) / names.length));
  }

  for (;;) {
    const { data, error: e1 } = await sb.from('reports').select('id')
      .gte('submitted_at', `${from}T00:00:00${CONFIG.UTC_OFFSET}`)
      .lt('submitted_at', `${addDays(to, 1)}T00:00:00${CONFIG.UTC_OFFSET}`)
      .limit(200);
    if (e1) throw e1;
    if (!data.length) break;
    const { data: gone, error: e2 } = await sb.from('reports').delete().in('id', data.map((r) => r.id)).select('id');
    if (e2) throw e2;
    // A delete blocked by permissions returns no error, only zero rows — stop instead of looping.
    if (!gone?.length) throw new Error('reports could not be deleted (permission denied)');
    onProgress(0.85);
  }
  onProgress(1);
}
