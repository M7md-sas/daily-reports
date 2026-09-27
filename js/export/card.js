// Builds the report card DOM (Section 10.1) and the PDF page-1 blocks.
// The same builder feeds the dashboard detail view and the PDF, so they always match.
import { t } from '../i18n.js?v=10';
import { el, fmtDate, fmtTime } from '../lib.js?v=10';
import { sanitizeReportHtml } from '../sanitize.js?v=10';

export function cardProjectName(r, lang) {
  if (r.project_other_name) return `${r.project_other_name} (${t('card.other', {}, lang)})`;
  return r.projects?.name ?? '';
}

/**
 * @param r      report row (with projects(name) joined)
 * @param photos [{ src, w?, h?, onClick? }] in display order
 * @param lang   'en' for the PDF; the UI language on screen
 */
export function buildCard(r, { photos = [], lang = 'en' } = {}) {
  const L = (k, v) => t(k, v, lang);
  const field = (label, value, cls = '') => el('div', { class: `fld ${cls}` },
    el('div', { class: 'lbl', text: label }),
    el('div', { class: 'val', dir: 'auto', text: value }));

  const identity = el('div', { class: 'rcard-id', 'data-break': '' },
    el('div', { class: 'rcard-id-top' },
      el('div', { class: 'rcard-name', dir: 'auto', text: r.consultant_name_snapshot }),
      el('div', { class: 'rcard-mobile' },
        el('span', { class: 'lbl', text: L('card.mobile') }),
        el('b', { text: r.consultant_mobile_snapshot }))),
    el('div', { class: 'rcard-fields' },
      field(L('card.type'), r.project_type),
      field(L('card.project'), cardProjectName(r, lang), 'wide'),
      field(L('card.date'), fmtDate(r.submitted_at)),
      field(L('card.time'), fmtTime(r.submitted_at))));

  const body = el('div', { class: 'rbody', html: sanitizeReportHtml(r.body_html) });
  const details = el('div', { class: 'rcard-sec' },
    el('div', { class: 'sec-lbl', 'data-break': '', text: L('card.details') }),
    body);

  const card = el('article', { class: 'rcard', lang, dir: lang === 'ar' ? 'rtl' : 'ltr' }, identity, details);

  const count = photos.length;
  const missing = Math.max(0, (r.photos_expected ?? 0) - (r.photo_count ?? count));
  if (count || missing) {
    const label = el('div', { class: 'sec-lbl', 'data-break': '' }, L('card.photos', { n: count }));
    if (missing) label.append(' ', el('span', { class: 'sec-note', text: `· ${L('card.photosPending', { n: missing })}` }));
    const grid = el('div', { class: 'rphotos' });
    for (let i = 0; i < count; i += 2) {
      grid.append(el('div', { class: 'prow', 'data-break': '' }, photoCell(photos[i]), photoCell(photos[i + 1])));
    }
    card.append(el('div', { class: 'rcard-sec' }, label, grid));
  }

  card.append(el('div', { class: 'rcard-foot', 'data-break': '', dir: 'auto', text: L('card.end', { name: r.consultant_name_snapshot }) }));
  return card;
}

// Fixed-size cell; when the image size is known the <img> gets explicit pixel
// dimensions (html2canvas does not support object-fit).
const CELL_W = 334;
const CELL_H = 248;
function photoCell(p) {
  if (!p) return el('div', { class: 'pcell empty' });
  const img = el('img', { src: p.src, alt: '', loading: 'lazy', decoding: 'async' });
  if (p.w && p.h) {
    const k = Math.min(CELL_W / p.w, CELL_H / p.h, 1);
    img.style.width = `${Math.round(p.w * k)}px`;
    img.style.height = `${Math.round(p.h * k)}px`;
    img.removeAttribute('loading');
  }
  if (p.onClick) return el('button', { type: 'button', class: 'pcell', onclick: p.onClick }, img);
  return el('div', { class: 'pcell' }, img);
}

export function buildContinued(r, lang = 'en') {
  return el('div', { class: 'rcard-cont', dir: 'auto', text: t('card.continued', { name: r.consultant_name_snapshot }, lang) });
}

export function buildTitleBlock(title, filterParts) {
  const filters = el('div', { class: 'pdf-filters' });
  filterParts.forEach(([label, value], i) => {
    if (i) filters.append(' | ');
    filters.append(`${label}: `, el('b', { dir: 'auto', text: value }));
  });
  return el('div', { class: 'pdf-title' }, el('h1', { text: title }), filters);
}

export function buildSummaryTable(rows, startIndex, showDate) {
  const head = ['#', 'Consultant', 'Mobile', 'Type', 'Project', ...(showDate ? ['Date'] : []), 'Time'];
  const table = el('table', { class: 'sumtable' },
    el('thead', {}, el('tr', {}, head.map((h) => el('th', { text: h })))));
  const tbody = el('tbody');
  rows.forEach((r, i) => {
    tbody.append(el('tr', {},
      el('td', { class: 'num', text: String(startIndex + i + 1) }),
      el('td', { dir: 'auto', text: r.consultant_name_snapshot }),
      el('td', { class: 'mob', text: r.consultant_mobile_snapshot }),
      el('td', { text: r.project_type }),
      el('td', { dir: 'auto', text: cardProjectName(r, 'en') }),
      showDate ? el('td', { text: fmtDate(r.submitted_at) }) : null,
      el('td', { text: fmtTime(r.submitted_at) })));
  });
  table.append(tbody);
  return table;
}
