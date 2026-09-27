// Storage meter (12.1) and archive flow (12.2).
import { CONFIG } from '../config.js?v=8';
import { t } from '../i18n.js?v=8';
import { el, fmtBytes, fmtIsoDay, todayIso, addDays, monthBounds, isoDay } from '../lib.js?v=8';
import { planArchive, buildArchivePart, deleteRange } from '../export/archive.js?v=8';
import { saveBlob } from '../export/data.js?v=8';
import { loadingBlock, errorBlock, viewHead, field, progressBar } from './ui.js?v=8';

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

  const yesterday = addDays(todayIso(), -1);
  const oldestDay = isoDay(oldest.data[0].submitted_at);
  const oldestMonth = monthBounds(oldestDay);
  if (oldestMonth.to > yesterday) oldestMonth.to = yesterday;

  let mode = 'oldest';
  const fromIn = el('input', { class: 'input', type: 'date', value: oldestMonth.from, max: yesterday });
  const toIn = el('input', { class: 'input', type: 'date', value: oldestMonth.to, max: yesterday });
  const customBox = el('div', { class: 'inline-form', hidden: true }, field(t('rl.from'), fromIn), field(t('rl.to'), toIn));
  const radio = (value, label) => el('label', {},
    el('input', {
      type: 'radio', name: 'arMode', value, checked: value === mode,
      onchange: () => { mode = value; customBox.hidden = mode !== 'custom'; reset(); },
    }),
    el('span', { text: label }));
  const oldestLabel = `${t('ar.oldestMonth')} (${fmtIsoDay(oldestMonth.from)} – ${fmtIsoDay(oldestMonth.to)})`;

  const previewBtn = el('button', { type: 'button', class: 'btn primary', text: t('ar.preview') });
  const previewBox = el('div');
  const msgBox = el('div');
  fromIn.addEventListener('change', () => reset());
  toIn.addEventListener('change', () => reset());

  root.append(el('div', { class: 'panel steps' },
    el('div', { class: 'radio-list' }, radio('oldest', oldestLabel), radio('custom', t('ar.custom'))),
    customBox,
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
    if (to >= todayIso() || from > to) {
      msgBox.replaceChildren(el('div', { class: 'msg error', text: t('ar.noToday') }));
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

  function showPlan(plan) {
    const prog = progressBar();
    const status = el('div');
    const dlBtn = el('button', { type: 'button', class: 'btn primary lg', text: t('ar.download') });
    const deleteZone = el('div', { class: 'danger-zone', hidden: true });

    previewBox.replaceChildren(
      el('div', { class: 'kv' },
        el('div', {}, el('b', { text: String(plan.reports) }), el('span', { text: t('ar.reports') })),
        el('div', {}, el('b', { text: String(plan.photos) }), el('span', { text: t('ar.photos') })),
        el('div', {}, el('b', { text: fmtBytes(plan.bytes) }), el('span', { text: t('ar.freed') }))),
      plan.parts.length > 1 ? el('p', { class: 'msg info', text: t('ar.parts', { n: plan.parts.length }) }) : null,
      el('div', {}, dlBtn),
      prog, status, deleteZone);

    dlBtn.addEventListener('click', async () => {
      dlBtn.disabled = true;
      previewBtn.disabled = true;
      status.replaceChildren();
      deleteZone.hidden = true;
      try {
        await ctx.loadLibs('html2canvas', 'jspdf', 'xlsx', 'jszip', 'filesaver');
        for (let i = 0; i < plan.parts.length; i++) {
          const part = plan.parts[i];
          const label = plan.parts.length > 1 ? ` (${i + 1}/${plan.parts.length})` : '';
          const { blob, name } = await buildArchivePart(ctx.sb, part, (fr) => {
            prog.set((i + fr) / plan.parts.length, t('ar.building', { p: `${Math.round(fr * 100)}%${label}` }));
          });
          saveBlob(blob, name);
        }
        prog.hide();
        status.replaceChildren(el('div', { class: 'msg ok', text: t('ar.built') }));
        showDeleteZone(plan, deleteZone);
      } catch (e) {
        prog.hide();
        status.replaceChildren(el('div', { class: 'msg error', role: 'alert', text: t('ar.failed', { msg: e.message ?? '' }) }));
      } finally {
        dlBtn.disabled = false;
        previewBtn.disabled = false;
      }
    });
  }

  function showDeleteZone(plan, zone) {
    const saved = el('input', { type: 'checkbox' });
    const typed = el('input', { class: 'input', autocomplete: 'off', dir: 'ltr', spellcheck: 'false' });
    const prog = progressBar();
    const msg = el('div');
    const btn = el('button', { type: 'button', class: 'btn danger', text: t('ar.delete'), disabled: true });
    const check = () => { btn.disabled = !(saved.checked && typed.value.trim() === 'DELETE'); };
    saved.addEventListener('change', check);
    typed.addEventListener('input', check);
    btn.addEventListener('click', () => {
      const job = { from: plan.from, to: plan.to, reports: plan.reports, photos: plan.photos, bytes: plan.bytes };
      writePending(job);
      runDelete(ctx, job, btn, prog, msg, again);
    });
    zone.replaceChildren(
      el('label', { class: 'toggle' }, saved, el('span', { text: t('ar.confirmSaved') })),
      field(t('ar.typeDelete'), typed),
      prog, msg, btn);
    zone.hidden = false;
  }
}

async function runDelete(ctx, job, btn, prog, msg, done) {
  btn.disabled = true;
  try {
    await deleteRange(ctx.sb, job.from, job.to, (fr) => prog.set(fr, t('ar.deleting', { p: `${Math.round(fr * 100)}%` })));
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
