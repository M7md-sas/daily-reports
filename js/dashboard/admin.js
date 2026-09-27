// Admin section (8.8) — admin role only (also enforced by RLS on app_settings).
import { CONFIG } from '../config.js?v=8';
import { t } from '../i18n.js?v=8';
import { el, fmtDateTime, fmtIsoDay, fmtBytes } from '../lib.js?v=8';
import { loadingBlock, errorBlock, viewHead, dataTable, field } from './ui.js?v=8';

const MODES = ['none', 'team_code', 'team_code_device'];

export async function render(ctx, view, _params, isCurrent) {
  view.replaceChildren(viewHead(t('nav.admin')), loadingBlock());
  const again = () => render(ctx, view, _params, isCurrent);
  const [settings, beat, log] = await Promise.all([
    ctx.sb.from('app_settings').select('*').eq('id', 1).single(),
    ctx.sb.from('heartbeat').select('last_ping').eq('id', 1).single(),
    ctx.sb.from('archive_log').select('*').order('archived_at', { ascending: false }).limit(100),
  ]);
  if (!isCurrent()) return;
  if (settings.error || beat.error || log.error) {
    view.lastChild.replaceWith(errorBlock(t('err.load'), again));
    return;
  }

  // ---------------------------------------------------------------- access protection
  const s = settings.data;
  let mode = s.access_mode;
  const code = el('input', { class: 'input', value: s.team_code ?? '', maxlength: 64, autocomplete: 'off', dir: 'ltr' });
  const maxPerDay = el('input', { class: 'input', type: 'number', min: 1, max: 200, value: s.max_reports_per_day });
  const msg = el('div');
  const radios = el('div', { class: 'radio-list' }, MODES.map((m) => el('label', {},
    el('input', { type: 'radio', name: 'mode', value: m, checked: m === mode, onchange: () => { mode = m; } }),
    el('span', { text: t(`ad.mode.${m}`) }))));
  const saveBtn = el('button', {
    type: 'submit', class: 'btn primary', text: t('common.save'),
  });
  const accessForm = el('form', {
    class: 'panel',
    onsubmit: async (e) => {
      e.preventDefault();
      const teamCode = code.value.trim();
      if (mode !== 'none' && !teamCode) {
        msg.replaceChildren(el('div', { class: 'msg error', text: t('ad.codeRequired') }));
        return;
      }
      saveBtn.disabled = true;
      const { error } = await ctx.sb.from('app_settings').update({
        access_mode: mode,
        team_code: teamCode || null,
        max_reports_per_day: Math.max(1, Math.min(200, Number(maxPerDay.value) || 20)),
      }).eq('id', 1);
      saveBtn.disabled = false;
      if (error) {
        msg.replaceChildren(el('div', { class: 'msg error', text: t('err.generic') }));
        return;
      }
      ctx.publicConfig = { access_mode: mode };
      msg.replaceChildren(el('div', { class: 'msg ok', text: t('ad.saved') }));
    },
  },
  radios,
  el('div', { class: 'inline-form', style: 'margin-top:12px' },
    field(t('ad.teamCode'), code),
    field(t('ad.maxPerDay'), maxPerDay, 'narrow')),
  msg,
  el('div', { style: 'margin-top:12px' }, saveBtn));

  // ---------------------------------------------------------------- heartbeat
  const last = new Date(beat.data.last_ping);
  const ageDays = (Date.now() - last.getTime()) / 86400000;
  const stale = ageDays > CONFIG.HEARTBEAT_WARN_DAYS;
  const heartbeat = el('div', { class: 'panel' },
    el('div', {}, `${t('ad.lastPing')}: `, el('b', { text: fmtDateTime(last) })),
    el('div', {
      class: `msg ${stale ? 'warn' : 'ok'}`,
      text: stale ? t('ad.pingOld', { n: CONFIG.HEARTBEAT_WARN_DAYS }) : t('ad.pingOk'),
    }));

  // ---------------------------------------------------------------- archive log
  const logTable = dataTable({
    rows: log.data,
    columns: [
      { label: t('ad.col.range'), render: (r) => `${fmtIsoDay(r.range_from)} – ${fmtIsoDay(r.range_to)}` },
      { label: t('col.reports'), cls: 'num', render: (r) => String(r.reports_count) },
      { label: t('col.photos'), cls: 'num', render: (r) => String(r.photos_count) },
      { label: t('ad.col.freed'), cls: 'num', render: (r) => fmtBytes(Number(r.bytes_freed)) },
      { label: t('ad.col.when'), cls: 'num', render: (r) => fmtDateTime(r.archived_at) },
    ],
  });

  // ---------------------------------------------------------------- password reset help
  const projectRef = new URL(CONFIG.SUPABASE_URL).hostname.split('.')[0];
  const password = el('div', { class: 'panel' },
    el('p', { text: t('ad.password.steps') }),
    el('a', {
      class: 'btn', target: '_blank', rel: 'noopener',
      href: `https://supabase.com/dashboard/project/${projectRef}/auth/users`,
      text: t('ad.password.open'),
    }));

  view.lastChild.replaceWith(el('div', {},
    el('h2', { class: 'section', text: t('ad.access') }), accessForm,
    el('h2', { class: 'section', text: t('ad.heartbeat') }), heartbeat,
    el('h2', { class: 'section', text: t('ad.log') }), logTable,
    el('h2', { class: 'section', text: t('ad.password') }), password));
}
