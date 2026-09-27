// Archive (Section 12.2): build the ZIP in the browser, then — only after the manager
// confirms — delete exactly what went into the ZIP files.
//
// Safety rules:
//  * Every storage object in the range goes into a ZIP: attached photos under Photos/…,
//    and any leftover upload that never got attached under Unattached/…
//  * Deletion removes only the report ids and object names recorded while building.
//  * Report rows are deleted before their photo files: if deletion stops half-way, the
//    leftover files are simply picked up (as Unattached) by the next archive.
import { CONFIG } from '../config.js?v=9';
import { isoDay, addDays } from '../lib.js?v=9';
import { fetchAllReports, photoLoader, exportBaseName, filterParts, downloadWithRetry } from './data.js?v=9';
import { buildPdf } from './pdf.js?v=9';
import { buildExcel, assignPhotoNames, sortedPhotos } from './excel.js?v=9';

/** All storage objects whose date folder is in the range (paged: the API returns ≤1000 rows per call). */
export async function listObjects(sb, from, to) {
  const PAGE = 1000;
  const out = [];
  for (let i = 0; ; i += PAGE) {
    const { data, error } = await sb.rpc('archive_object_names', { p_from: from, p_to: to }).range(i, i + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

/** Counts, size and the split into ZIP parts for a date range. */
export async function planArchive(sb, from, to) {
  const perDay = new Map();
  let reports = 0;
  const BATCH = 1000;
  for (let i = 0; ; i += BATCH) {
    const { data, error } = await sb.from('reports')
      .select('submitted_at')
      .gte('submitted_at', `${from}T00:00:00${CONFIG.UTC_OFFSET}`)
      .lt('submitted_at', `${addDays(to, 1)}T00:00:00${CONFIG.UTC_OFFSET}`)
      .order('submitted_at')
      .range(i, i + BATCH - 1);
    if (error) throw error;
    for (const r of data) {
      const d = isoDay(r.submitted_at);
      perDay.set(d, (perDay.get(d) ?? 0) + 20000); // rough PDF share per report
    }
    reports += data.length;
    if (data.length < BATCH) break;
  }

  const objects = await listObjects(sb, from, to);
  const bytes = objects.reduce((s, o) => s + Number(o.size_bytes ?? 0), 0);
  for (const o of objects) {
    const d = o.name.slice(0, 10).replace(/\//g, '-');
    perDay.set(d, (perDay.get(d) ?? 0) + Number(o.size_bytes ?? 0));
  }

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
  // Consecutive parts touch, and together cover the whole requested range.
  if (parts.length) {
    parts[0].from = from;
    for (let i = 1; i < parts.length; i++) parts[i].from = addDays(parts[i - 1].to, 1);
    parts[parts.length - 1].to = to;
  }
  return { from, to, reports, photos: objects.length, bytes, parts };
}

/**
 * Builds one archive ZIP. Throws on any failure (nothing is deleted by this function).
 * Returns what it contains so that deletion can remove exactly that.
 * onProgress(fraction)
 */
export async function buildArchivePart(sb, part, onProgress = () => {}) {
  const f = { from: part.from, to: part.to };
  const reports = await fetchAllReports(sb, f);
  const objects = await listObjects(sb, part.from, part.to);
  const cache = new Map();
  const load = photoLoader(sb, cache);

  // 1. Download every photo first — if any is missing, fail before anything else.
  for (let i = 0; i < reports.length; i++) {
    await load(reports[i]);
    onProgress(0.4 * ((i + 1) / Math.max(1, reports.length)));
  }
  const attached = new Set(reports.flatMap((r) => sortedPhotos(r).map((p) => p.storage_path)));
  const unattached = objects.filter((o) => !attached.has(o.name));
  for (const o of unattached) cache.set(o.name, await downloadWithRetry(sb, o.name));
  onProgress(0.45);

  const range = { from: part.from, to: part.to };
  const base = exportBaseName('Daily_Reports', range);
  const names = assignPhotoNames(reports);

  // 2. PDF + Excel of the same reports.
  const pdf = await buildPdf({
    reports,
    filterParts: filterParts(f, {}, reports.length, range),
    loadPhotos: load,
    onProgress: (d, n) => onProgress(0.45 + 0.4 * (d / n)),
  });
  const xlsx = buildExcel(reports, names);

  // 3. ZIP (photos are already JPEG, so store without re-compressing).
  const zip = new window.JSZip();
  zip.file(`${base}.pdf`, pdf);
  zip.file(`${base}.xlsx`, xlsx);
  for (const r of reports) {
    for (const p of sortedPhotos(r)) zip.file(names.get(p.storage_path), cache.get(p.storage_path));
  }
  for (const o of unattached) zip.file(`Unattached/${o.name}`, cache.get(o.name));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true },
    (meta) => onProgress(0.85 + 0.15 * (meta.percent / 100)));
  cache.clear();

  return {
    blob,
    name: `${exportBaseName('Archive', range)}.zip`,
    reportIds: reports.map((r) => r.id),
    objectNames: [...attached, ...unattached.map((o) => o.name)],
    photos: attached.size + unattached.length,
    bytes: objects.reduce((s, o) => s + Number(o.size_bytes ?? 0), 0),
  };
}

/**
 * Deletes exactly the given report ids, then the given storage objects. Safe to run again:
 * already-deleted rows and files are simply skipped.
 */
export async function deleteArchived(sb, { reportIds, objectNames }, onProgress = () => {}) {
  const total = reportIds.length + objectNames.length || 1;
  let done = 0;

  const ROWS = 200;
  for (let i = 0; i < reportIds.length; i += ROWS) {
    const ids = reportIds.slice(i, i + ROWS);
    const { data: gone, error } = await sb.from('reports').delete().in('id', ids).select('id');
    if (error) throw error;
    // A delete blocked by permissions returns no error and zero rows. Zero rows is also
    // what a re-run returns, so check whether the rows still exist before failing.
    if (!gone?.length) {
      const { data: still, error: e2 } = await sb.from('reports').select('id').in('id', ids).limit(1);
      if (e2) throw e2;
      if (still?.length) throw new Error('reports could not be deleted (permission denied)');
    }
    done += ids.length;
    onProgress(done / total);
  }

  const FILES = 100;
  for (let i = 0; i < objectNames.length; i += FILES) {
    const chunk = objectNames.slice(i, i + FILES);
    const { error } = await sb.storage.from(CONFIG.PHOTO_BUCKET).remove(chunk);
    if (error) throw error;
    done += chunk.length;
    onProgress(done / total);
  }

  // Verify: nothing we zipped may remain in storage.
  if (objectNames.length) {
    const days = objectNames.map((n) => n.slice(0, 10).replace(/\//g, '-')).sort();
    const left = new Set((await listObjects(sb, days[0], days[days.length - 1])).map((o) => o.name));
    if (objectNames.some((n) => left.has(n))) throw new Error('some photos could not be deleted (permission denied)');
  }
  onProgress(1);
}
