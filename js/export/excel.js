// Excel export (Section 10.2): one sheet, one row per report, no special styling.
import { fmtDate, fmtTime, photoArchivePath } from '../lib.js';
import { cardProjectName } from './card.js';

const MAX_CELL = 32000; // Excel's hard limit is 32,767 characters per cell.

/**
 * Gives every photo its path inside the archive ZIP. Two reports by the same
 * consultant in the same minute and project would collide, so later ones get a suffix.
 * @returns Map<storage_path, zip path>
 */
export function assignPhotoNames(reports) {
  const names = new Map();
  const used = new Set();
  for (const r of reports) {
    sortedPhotos(r).forEach((p, i) => {
      let path = photoArchivePath(r, i + 1);
      for (let k = 2; used.has(path.toLowerCase()); k++) path = photoArchivePath(r, `${i + 1}_${k}`);
      used.add(path.toLowerCase());
      names.set(p.storage_path, path);
    });
  }
  return names;
}

export function buildExcel(reports, names = assignPhotoNames(reports)) {
  const XLSX = window.XLSX;
  const header = ['Date', 'Time', 'Consultant', 'Mobile', 'Project Type', 'Project Name',
    'Report Text', 'Photo Count', 'Photo Files'];
  const rows = reports.map((r) => {
    const photos = sortedPhotos(r);
    return [
      fmtDate(r.submitted_at),
      fmtTime(r.submitted_at),
      r.consultant_name_snapshot,
      r.consultant_mobile_snapshot,
      r.project_type,
      cardProjectName(r, 'en'),
      (r.body_text ?? '').slice(0, MAX_CELL),
      photos.length,
      photos.map((p) => names.get(p.storage_path)).join('\n').slice(0, MAX_CELL),
    ];
  });
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [12, 7, 24, 15, 12, 28, 70, 11, 60].map((wch) => ({ wch }));
  ws['!autofilter'] = { ref: `A1:I${rows.length + 1}` };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Reports');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function sortedPhotos(r) {
  return [...(r.report_photos ?? [])].sort((a, b) => a.sort_order - b.sort_order);
}
