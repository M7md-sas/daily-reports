// Consultants (Section 8.5): registrations, last submission, Active toggle.
import { t } from '../i18n.js?v=3';
import { el, fmtDate, fmtDateTime } from '../lib.js?v=3';
import { loadingBlock, errorBlock, viewHead, dataTable } from './ui.js?v=3';

export async function render(ctx, view, _params, isCurrent) {
  view.replaceChildren(viewHead(t('nav.consultants')), loadingBlock());
  const { data, error } = await ctx.sb.from('consultant_overview').select('*').order('full_name');
  if (!isCurrent()) return;
  if (error) {
    view.lastChild.replaceWith(errorBlock(t('err.load'), () => render(ctx, view, _params, isCurrent)));
    return;
  }
  const deviceLock = ctx.publicConfig?.access_mode === 'team_code_device';

  const columns = [
    { label: t('col.name'), cls: 'name', render: (c) => el('span', { dir: 'auto', text: c.full_name }) },
    { label: t('col.mobile'), cls: 'mob', render: (c) => el('a', { href: `tel:${c.mobile}`, text: c.mobile }) },
    { label: t('col.registered'), cls: 'num', render: (c) => fmtDate(c.created_at) },
    { label: t('col.lastSubmission'), cls: 'num', render: (c) => (c.last_submitted_at ? fmtDateTime(c.last_submitted_at) : el('span', { class: 'muted', text: t('cs.never') })) },
    {
      label: t('common.active'),
      render: (c) => {
        const box = el('input', {
          type: 'checkbox', checked: c.is_active, 'aria-label': `${t('common.active')} — ${c.full_name}`,
          onchange: async (e) => {
            box.disabled = true;
            const { error: err } = await ctx.sb.from('consultants').update({ is_active: e.target.checked }).eq('id', c.id);
            box.disabled = false;
            if (err) { e.target.checked = !e.target.checked; ctx.toast(t('err.generic')); }
          },
        });
        return el('label', { class: 'toggle' }, box);
      },
    },
  ];
  if (deviceLock) {
    columns.push({
      label: '',
      render: (c) => (c.allow_new_device
        ? el('span', { class: 'pill', text: t('cs.deviceAllowed') })
        : el('button', {
          type: 'button', class: 'btn sm', text: t('cs.allowDevice'),
          onclick: async (e) => {
            e.target.disabled = true;
            const { error: err } = await ctx.sb.from('consultants').update({ allow_new_device: true }).eq('id', c.id);
            if (err) { ctx.toast(t('err.generic')); e.target.disabled = false; return; }
            e.target.replaceWith(el('span', { class: 'pill', text: t('cs.deviceAllowed') }));
          },
        })),
    });
  }

  view.lastChild.replaceWith(el('div', {},
    el('p', { class: 'muted small', text: t('cs.hint') }),
    dataTable({ rows: data, columns })));
}
