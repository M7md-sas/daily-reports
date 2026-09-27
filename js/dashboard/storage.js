// Storage meter (12.1) and archive flow (12.2).
import { CONFIG } from '../config.js?v=9';
import { t } from '../i18n.js?v=9';
import { el, fmtBytes, fmtIsoDay, todayIso, addDays, monthBounds, isoDay } from '../lib.js?v=9';
import { planArchive, buildArchivePart, deleteArchived } from '../export/archive.js?v=9';
import { saveBlob } from '../export/data.js?v=9';
import { loadingBlock, errorBlock, viewHead, field, progressBar } from './ui.js?v=9';

const PENDING_KEY = 'dcr.archive.pending';
const readPending = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY)); } catch { return null; } };
const writePending = (v) => { try { v ? localStorage.setItem(PENDING_KEY, JSON.stringify(v)) : localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ } };

export async function render(ctx, view, _params, isCurrent) {
  view.replaceChildren(viewHead(t('nav.storage')), loadingBlock());
  const again = () => render(ctx, view, _params, isCurrent);

  const [usage, oldest] = await Promise.all([
    ctx.sb.rpc('storage_usage'),
    ctx.sb.from('reports').select('submitted_at').order('submitted_at').limit(1),
  ]);
  if (!isCurrent()) return;
  if (usage.error || oldest.error) {
    view.lastChild.replaceWith(errorBlock(t('err.load'), again));
    return;
  }

  const root = el('div');
  view.lastChild.replaceWith(root);

  // ---------------------------------------------------------------- meters
  const u = usage.data;
  const photoPct = (u.photos_bytes / CONFIG.STORAGE_LIMIT_BYTES) * 100;
  const dbPct = (u.db_bytes / CONFIG.DB_LIMIT_BYTES) * 100;
  const worst = Math.max(photoPct, dbPct);
  const meter = (label, used, limit, pct) => el('div', { class: 'meter' },
    el('div', { class: 'meter-head' },
      el('span', { text: label }),
      el('span', { text: `${fmtBytes(used)} / ${fmtBytes(limit)} · ${pct.toFixed(1)}%` })),
    el('div', {
      class: `progress ${pct >= CONFIG.DANGER_PERCENT ? 'danger' : pct >= CONFIG.WARN_PERCENT ? 'warn' : ''}`,
      role: 'progressbar', 'aria-valuenow': pct.toFixed(0), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': label,
    }, el('span', { style: `width:${Math.min(100, pct)}%` })));

  if (worst >= CONFIG.DANGER_PERCENT) root.append(el('div', { class: 'msg error', role: 'alert', text: t('st.danger', { p: CONFIG.DANGER_PERCENT }) }));
  else if (worst >= CONFIG.WARN_PERCENT) root.append(el('div', { class: 'msg warn', role: 'alert', text: t('st.warn', { p: CONFIG.WARN_PERCENT }) }));

  root.append(el('div', { class: 'panel' },
    meter(t('st.photos'), u.photos_bytes, CONFIG.STORAGE_LIMIT_BYTES, photoPct),
    meter(t('st.db'), u.db_bytes, CONFIG.DB_LIMIT_BYTES, dbPct)));

  // ---------------------------------------------------------------- archive
  root.append(el('h2', { class: 'section', text: t('ar.title') }), el('p', { class: 'muted section-hint', text: t('ar.intro') }));

  const pending = readPending();
  if (pending) {
    const prog = progressBar();
    const msg = el('div', { class: 'msg warn', role: 'alert' }, t('ar.resume', { from: fmtIsoDay(pending.from), to: fmtIsoDay(pending.to) }));
    const btn = el('button', {
      type: 'button', class: 'btn danger', text: t('ar.resumeBtn'),
      onclick: () => runDelete(ctx, pending, btn, prog, msg, again),
    });
    root.append(el('div', { class: 'danger-zone' }, msg, prog, btn));
    return;
  }

  const phone = window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 1000;
  if (phone) {
    root.append(el('div', { class: 'msg info', text: t('ar.desktopOnly') }));
    return;
  }
  if (!oldest.data.length) {
    root.append(el('p', { class: 'muted', text: t('ar.none') }));
    return;
  }

  // Consultants may still upload photos for 3 days after a report, so the newest day that
  // can be archived is 4 days ago.
  const lastDay = addDays(todayIso(), -4);
  const oldestDay = isoDay(oldest.data[0].submitted_at);
  const oldestMonth = monthBounds(oldestDay);
  if (oldestMonth.to > lastDay) oldestMonth.to = lastDay;

  let mode = 'oldest';
  const fromIn = el('input', { class: 'input', type: 'date', value: oldestMonth.from, max: lastDay });
  const toIn = el('input', { class: 'input', type: 'date', value: oldestMonth.to, max: lastDay });
  const customBox = el('div', { class: 'inline-form', hidden: true }, field(t('rl.from'), fromIn), field(t('rl.to'), toIn));
  const radio = (value, label) => el('label', {},
    el('input', {
      type: 'radio', name: 'arMode', value, checked: value === mode,
      onchange: () => { mode = value; customBox.hidden = mode !== 'custom'; reset(); },
    }),
    el('span', { text: label }));
  const oldestLabel = oldestMonth.from <= oldestMonth.to
    ? `${t('ar.oldestMonth')} (${fmtIsoDay(oldestMonth.from)} – ${fmtIsoDay(oldestMonth.to)})`
    : t('ar.oldestMonth');

  const previewBtn = el('button', { type: 'button', class: 'btn primary', text: t('ar.preview') });
  const previewBox = el('div');
  const msgBox = el('div');
  fromIn.addEventListener('change', () => reset());
  toIn.addEventListener('change', () => reset());

  root.append(el('div', { class: 'panel steps' },
    el('div', { class: 'radio-list' }, radio('oldest', oldestLabel), radio('custom', t('ar.custom'))),
    customBox,
    el('p', { class: 'muted small', style: 'margin:0', text: t('ar.lastDay', { d: fmtIsoDay(lastDay) }) }),
    el('div', {}, previewBtn),
    msgBox,
    previewBox));

  function reset() {
    previewBox.replaceChildren();
    msgBox.replaceChildren();
  }
  const range = () => (mode === 'oldest' ? { ...oldestMonth } : { from: fromIn.value, to: toIn.value });

  previewBtn.addEventListener('click', async () => {
    reset();
    const { from, to } = range();
    if (!from || !to) return;
    if (to > lastDay || from > to) {
      msgBox.replaceChildren(el('div', { class: 'msg error', text: t('ar.noToday', { d: fmtIsoDay(lastDay) }) }));
      return;
    }
    previewBtn.disabled = true;
    previewBox.replaceChildren(loadingBlock());
    try {
      const plan = await planArchive(ctx.sb, from, to);
      if (!isCurrent()) return;
      if (!plan.reports && !plan.photos) {
        previewBox.replaceChildren(el('p', { class: 'muted', text: t('ar.empty') }));
        return;
      }
      showPlan(plan);
    } catch (e) {
      previewBox.replaceChildren(errorBlock(`${t('err.load')} ${e.message ?? ''}`));
    } finally {
      previewBtn.disabled = false;
    }
  });

  // One button per ZIP part, each saved from its own click (browsers block several
  // downloads started by one click). Deletion unlocks only when every part was saved.
  function showPlan(plan) {
    const results = new Array(plan.parts.length).fill(null);
    const prog = progressBar();
    const status = el('div');
    const deleteZone = el('div', { class: 'danger-zone', hidden: true });
    let building = false;

    const partRow = (part, i) => {
      const label = plan.parts.length > 1
        ? t('ar.downloadPart', { i: i + 1, n: plan.parts.length })
        : t('ar.download');
      const btn = el('button', { type: 'button', class: 'btn primary', text: label });
      const state = el('span', { class: 'muted small' }, `${fmtIsoDay(part.from)} – ${fmtIsoDay(part.to)}`);
      btn.addEventListener('click', async () => {
        if (building) return;
        building = true;
        btn.disabled = true;
        status.replaceChildren();
        try {
          await ctx.loadLibs('html2canvas', 'jspdf', 'xlsx', 'jszip', 'filesaver');
          const res = await buildArchivePart(ctx.sb, part, (fr) => {
            prog.set(fr, t('ar.building', { p: `${Math.round(fr * 100)}%` }));
          });
          saveBlob(res.blob, res.name);
          res.blob = null;
          results[i] = res;
          prog.hide();
          state.replaceChildren(el('b', { text: `✓ ${res.name}` }));
          btn.textContent = t('ar.downloadAgain');
          if (results.every(Boolean)) {
            status.replaceChildren(el('div', { class: 'msg ok', text: t('ar.built', { files: results.map((r) => r.name).join('، ') }) }));
            showDeleteZone(plan, results, deleteZone);
          }
        } catch (e) {
          prog.hide();
          status.replaceChildren(el('div', { class: 'msg error', role: 'alert', text: t('ar.failed', { msg: e.message ?? '' }) }));
        } finally {
          building = false;
          btn.disabled = false;
        }
      });
      return el('div', { class: 'part-row' }, btn, state);
    };

    previewBox.replaceChildren(
      el('div', { class: 'kv' },
        el('div', {}, el('b', { text: String(plan.reports) }), el('span', { text: t('ar.reports') })),
        el('div', {}, el('b', { text: String(plan.photos) }), el('span', { text: t('ar.photos') })),
        el('div', {}, el('b', { text: fmtBytes(plan.bytes) }), el('span', { text: t('ar.freed') }))),
      plan.parts.length > 1 ? el('p', { class: 'msg info', text: t('ar.parts', { n: plan.parts.length }) }) : null,
      el('div', { class: 'part-list' }, plan.parts.map(partRow)),
      prog, status, deleteZone);
  }

  function showDeleteZone(plan, results, zone) {
    const saved = el('input', { type: 'checkbox' });
    const typed = el('input', { class: 'input', autocomplete: 'off', dir: 'ltr', spellcheck: 'false' });
    const prog = progressBar();
    const msg = el('div');
    const btn = el('button', { type: 'button', class: 'btn danger', text: t('ar.delete'), disabled: true });
    const check = () => { btn.disabled = !(saved.checked && typed.value.trim() === 'DELETE'); };
    saved.addEventListener('change', check);
    typed.addEventListener('input', check);
    btn.addEventListener('click', () => {
      const job = {
        from: plan.from, to: plan.to,
        reportIds: results.flatMap((r) => r.reportIds),
        objectNames: results.flatMap((r) => r.objectNames),
        photos: results.reduce((s, r) => s + r.photos, 0),
        bytes: results.reduce((s, r) => s + r.bytes, 0),
      };
      job.reports = job.reportIds.length;
      writePending(job);
      runDelete(ctx, job, btn, prog, msg, again);
    });
    zone.replaceChildren(
      el('p', { class: 'small', text: t('ar.checkFiles', { n: results.length }) }),
      el('label', { class: 'toggle' }, saved, el('span', { text: t('ar.confirmSaved') })),
      field(t('ar.typeDelete'), typed),
      prog, msg, btn);
    zone.hidden = false;
  }
}

async function runDelete(ctx, job, btn, prog, msg, done) {
  btn.disabled = true;
  if (!job.reportIds || !job.objectNames) {
    writePending(null);
    ctx.toast(t('ar.oldJob'));
    done();
    return;
  }
  try {
    await deleteArchived(ctx.sb, job, (fr) => prog.set(fr, t('ar.deleting', { p: `${Math.round(fr * 100)}%` })));
    const { error } = await ctx.sb.from('archive_log').insert({
      range_from: job.from, range_to: job.to,
      reports_count: job.reports, photos_count: job.photos, bytes_freed: job.bytes,
      archived_by: ctx.user.id,
    });
    if (error) throw error;
    writePending(null);
    ctx.toast(t('ar.done', { r: job.reports, ph: job.photos }));
    done();
  } catch (e) {
    prog.hide();
    msg.replaceChildren(el('div', { class: 'msg error', role: 'alert', text: t('ar.deleteFailed', { msg: e.message ?? '' }) }));
    btn.disabled = false;
  }
}
