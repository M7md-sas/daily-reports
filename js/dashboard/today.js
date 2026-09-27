// Today (Section 8.1): who submitted, who did not.
import { t, getLang } from '../i18n.js?v=4';
import { el, fmtDate, fmtTime, todayIso, dayStart, dayEndExclusive } from '../lib.js?v=4';
import { LIST_COLS } from '../export/data.js?v=4';
import { cardProjectName } from '../export/card.js?v=4';
import { loadingBlock, errorBlock, viewHead, statCard } from './ui.js?v=4';

export async function render(ctx, view, _params, isCurrent) {
  const refresh = el('button', { type: 'button', class: 'btn sm', text: '↻', 'aria-label': t('common.retry'), onclick: () => render(ctx, view, _params, isCurrent) });
  view.replaceChildren(viewHead(`${t('nav.today')} — ${fmtDate(new Date())}`, refresh), loadingBlock());

  const day = todayIso();
  const [rep, cons] = await Promise.all([
    ctx.sb.from('reports').select(LIST_COLS)
      .gte('submitted_at', dayStart(day)).lt('submitted_at', dayEndExclusive(day))
      .order('submitted_at', { ascending: false }),
    ctx.sb.from('consultants').select('id, full_name, mobile').eq('is_active', true).order('full_name'),
  ]);
  if (!isCurrent()) return;
  const error = rep.error || cons.error;
  if (error) {
    view.lastChild.replaceWith(errorBlock(t('err.load'), () => render(ctx, view, _params, isCurrent)));
    return;
  }

  const submittedIds = new Set(rep.data.map((r) => r.consultant_id));
  const missing = cons.data.filter((c) => !submittedIds.has(c.id));
  const activeSubmitted = cons.data.length - missing.length;

  const stats = el('div', { class: 'stats' },
    statCard(activeSubmitted, t('today.submitted')),
    statCard(missing.length, t('today.notSubmitted'), true),
    statCard(rep.data.length, t('nav.reports'), true),
    statCard(cons.data.length, `${t('nav.consultants')} (${t('common.active')})`, true));

  const submittedList = rep.data.length
    ? el('ul', { class: 'list' }, rep.data.map((r) => el('li', {},
      el('a', { class: 'row', href: `#report/${r.id}` },
        el('span', { class: 'time', text: fmtTime(r.submitted_at) }),
        el('span', { class: 'who' },
          el('b', { dir: 'auto', text: r.consultant_name_snapshot }),
          el('span', { dir: 'auto', text: cardProjectName(r, getLang()) })),
        el('span', { class: 'pill', text: r.project_type })))))
    : el('p', { class: 'center-state', text: t('today.noneYet') });

  const missingList = missing.length
    ? el('ul', { class: 'list' }, missing.map((c) => el('li', {},
      el('span', { class: 'who' }, el('b', { dir: 'auto', text: c.full_name })),
      el('a', { class: 'ltr', href: `tel:${c.mobile}`, text: c.mobile }))))
    : el('p', { class: 'center-state', text: t('today.allDone') });

  view.lastChild.replaceWith(el('div', {},
    stats,
    el('h2', { class: 'section', text: `${t('today.submitted')} (${rep.data.length})` }),
    el('div', { class: 'table-wrap' }, submittedList),
    el('h2', { class: 'section', text: `${t('today.notSubmitted')} (${missing.length})` }),
    el('div', { class: 'table-wrap' }, missingList)));
}
