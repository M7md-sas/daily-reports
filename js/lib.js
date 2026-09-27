// Shared helpers: Supabase client, dates in Asia/Riyadh, mobile numbers, file names.
// supabase-js 2.117.2 comes from vendor/supabase.js (a plain script loaded before this module).
import { CONFIG } from './config.js?v=9';

// The consultant page must always act as anonymous, even if a manager is
// signed in to the dashboard in the same browser — so it never persists a session.
// A stalled request on a weak mobile network must not freeze the screen: give up after a
// while so the normal Retry path takes over. Photo uploads/downloads get longer.
function fetchWithTimeout(input, init = {}) {
  const url = String(input?.url ?? input);
  const ms = /\/storage\/v1\/object\//.test(url) ? 120000 : 30000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), ms);
  if (init.signal) init.signal.addEventListener('abort', () => ctrl.abort(init.signal.reason), { once: true });
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

export function createSupabase({ anonymous = false } = {}) {
  return window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
    global: { fetch: fetchWithTimeout },
    auth: anonymous
      ? { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      : {
        // Per-tab storage: other sites on the shared github.io origin cannot read the session
        // from another tab (the manager signs in again in a new tab).
        persistSession: true, autoRefreshToken: true, storageKey: 'dcr-dashboard-auth',
        storage: window.sessionStorage,
      },
  });
}

// ---------------------------------------------------------------- dates (Asia/Riyadh)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function riyadhParts(value) {
  const d = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG.TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
}

/** 24 Sep 2026 */
export function fmtDate(value) {
  const p = riyadhParts(value);
  return `${p.d} ${MONTHS[Number(p.m) - 1]} ${p.y}`;
}
/** 08:42 */
export function fmtTime(value) {
  const p = riyadhParts(value);
  return `${p.h}:${p.min}`;
}
export function fmtDateTime(value) {
  return `${fmtDate(value)}, ${fmtTime(value)}`;
}
/** 2026-09-24 (Riyadh calendar day) */
export function isoDay(value) {
  const p = riyadhParts(value);
  return `${p.y}-${p.m}-${p.d}`;
}
/** 0842 */
export function hhmm(value) {
  const p = riyadhParts(value);
  return `${p.h}${p.min}`;
}
export function todayIso() {
  return isoDay(new Date());
}
/** Formats a YYYY-MM-DD string (a calendar day, not an instant). */
export function fmtIsoDay(iso) {
  const [y, m, d] = iso.split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}
/** Start of a Riyadh calendar day as an ISO instant. */
export function dayStart(iso) {
  return `${iso}T00:00:00${CONFIG.UTC_OFFSET}`;
}
/** Start of the day after `iso` — use as an exclusive upper bound. */
export function dayEndExclusive(iso) {
  return dayStart(addDays(iso, 1));
}
export function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function monthBounds(iso) {
  const [y, m] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

// ---------------------------------------------------------------- mobile numbers

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function toWesternDigits(s) {
  return String(s ?? '').replace(/[٠-٩۰-۹]/g, (ch) => {
    const i = ARABIC_DIGITS.indexOf(ch);
    return String(i >= 0 ? i : PERSIAN_DIGITS.indexOf(ch));
  });
}

/** Returns +9665XXXXXXXX or null. Mirrors public.normalize_mobile() in the database. */
export function normalizeMobile(input) {
  const d = toWesternDigits(input).replace(/[\s\-().]/g, '');
  if (/^05\d{8}$/.test(d)) return '+966' + d.slice(1);
  if (/^5\d{8}$/.test(d)) return '+966' + d;
  if (/^\+9665\d{8}$/.test(d)) return d;
  if (/^9665\d{8}$/.test(d)) return '+' + d;
  if (/^009665\d{8}$/.test(d)) return '+' + d.slice(2);
  return null;
}

// ---------------------------------------------------------------- misc

export const PROJECT_TYPES = ['UGC', 'S/S', 'OHTL'];

export function projectName(report) {
  if (report.project_other_name) return `${report.project_other_name} (Other)`;
  return report.projects?.name ?? report.project_name ?? '';
}
export function projectNameRaw(report) {
  return report.project_other_name ?? report.projects?.name ?? report.project_name ?? '';
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Safe for file and folder names on Windows, macOS and Android; keeps Arabic letters. */
export function safeFileName(s, max = 60) {
  const cleaned = String(s ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (cleaned || 'Untitled').slice(0, max).trim();
}

/** Relative path of a photo inside the archive ZIP (also used in Excel "Photo Files"). */
export function photoArchivePath(report, n) {
  const name = safeFileName(report.consultant_name_snapshot);
  const project = safeFileName(projectNameRaw(report), 40).replace(/ /g, '_');
  return `Photos/${name}/${isoDay(report.submitted_at)}/${hhmm(report.submitted_at)}_${project}_${n}.jpg`;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` over items with at most `limit` in flight. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Maps a Supabase/Postgres error to a translation key when it is one of ours. */
export function errorKey(err) {
  const msg = String(err?.message ?? err ?? '');
  const known = [
    'invalid_team_code', 'invalid_mobile', 'device_bound_other', 'device_required', 'code_required', 'code_length', 'invalid_name', 'device_not_allowed',
    'device_not_recognized', 'mobile_taken', 'unknown_consultant', 'invalid_project',
    'invalid_project_type', 'empty_report', 'too_many_photos', 'daily_limit', 'report_conflict',
    'upload_refused', 'photos_missing_locally', 'rate_limited', 'bad_html', 'mobile_change_manager', 'unknown_report',
  ];
  const hit = known.find((k) => msg.includes(k));
  if (hit) return `err.${hit}`;
  if (/Failed to fetch|NetworkError|network|Load failed|timeout|abort/i.test(msg)) return 'err.network';
  return 'err.generic';
}
