// Consultants (Section 8.5): registrations, last submission, Active toggle,
// plus the team access code (manager may change it) and releasing a phone.
import { t } from '../i18n.js?v=8';
import { el, fmtDate, fmtDateTime, errorKey } from '../lib.js?v=8';
import { loadingBlock, errorBlock, viewHead, dataTable, field } from './ui.js?v=8';

export async function render(ctx, view, _params, isCurrent) {
  view.replaceChildren(viewHead(t('nav.consultants')), loadingBlock());
  const again = () => render(ctx, view, _params, isCurrent);
  const [list, codeRes] = await Promise.all([
    ctx.sb.from('consultant_overview').select('*').order('full_name'),
    ctx.sb.rpc('get_team_code'),
  ]);
  if (!isCurrent()) return;
  if (list.error || codeRes.error) {
    view.lastChild.replaceWith(errorBlock(t('err.load'), again));
    return;
  }
  const data = list.data;
  const mode = codeRes.data.access_mode;
  const deviceLock = mode === 'team_code_device';

  // ---------------------------------------------------------------- team code
  const codeIn = el('input', {
    class: 'input', value: codeRes.data.team_code ?? '', maxlength: 64, autocomplete: 'off', dir: 'ltr', spellcheck: 'false',
  });
  const codeMsg = el('div');
  const saveBtn = el('button', { type: 'submit', class: 'btn primary', text: t('common.save') });
  const codePanel = el('form', {
    class: 'panel',
    onsubmit: async (e) => {
      e.preventDefault();
      saveBtn.disabled = true;
      const { data: res, error } = await ctx.sb.rpc('set_team_code', { p_code: codeIn.value });
      saveBtn.disabled = false;
      if (error) {
        codeMsg.replaceChildren(el('div', { class: 'msg error', text: t(errorKey(error)) }));
        return;
      }
      codeIn.value = res.team_code ?? '';
      codeMsg.replaceChildren(el('div', { class: 'msg ok', text: t('cs.codeSaved') }));
    },
  },
  el('div', { class: 'inline-form' }, field(t('ad.teamCode'), codeIn), saveBtn),
  el('p', { class: 'muted small', style: 'margin:8px 0 0', text: t(mode === 'none' ? 'cs.codeOff' : 'cs.codeOn') }),
  codeMsg);

  // ---------------------------------------------------------------- list
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
    {
      label: t('cs.phone'),
      render: (c) => {
        const box = el('div', { class: 'actions' });
        if (Number(c.phones) > 0) {
          box.append(el('span', { class: 'pill', text: t('cs.bound') }));
          box.append(el('button', {
            type: 'button', class: 'btn sm', text: t('cs.release'),
            onclick: async (e) => {
              if (!window.confirm(t('cs.releaseConfirm', { name: c.full_name }))) return;
              e.target.disabled = true;
              const { error: err } = await ctx.sb.rpc('release_consultant_devices', { p_consultant_id: c.id });
              if (err) { ctx.toast(t('err.generic')); e.target.disabled = false; return; }
              ctx.toast(t('cs.released'));
              again();
            },
          }));
        } else {
          box.append(el('span', { class: 'pill muted', text: t('cs.unbound') }));
        }
        if (deviceLock) {
          box.append(c.allow_new_device
            ? el('span', { class: 'pill', text: t('cs.deviceAllowed') })
            : el('button', {
              type: 'button', class: 'btn sm', text: t('cs.allowDevice'),
              onclick: async (e) => {
                e.target.disabled = true;
                const { error: err } = await ctx.sb.from('consultants').update({ allow_new_device: true }).eq('id', c.id);
                if (err) { ctx.toast(t('err.generic')); e.target.disabled = false; return; }
                e.target.replaceWith(el('span', { class: 'pill', text: t('cs.deviceAllowed') }));
              },
            }));
        }
        return box;
      },
    },
  ];

  view.lastChild.replaceWith(el('div', {},
    el('h2', { class: 'section', style: 'margin-top:0', text: t('ad.teamCode') }),
    codePanel,
    el('h2', { class: 'section', text: t('nav.consultants') }),
    el('p', { class: 'muted small section-hint', text: t('cs.hint') }),
    dataTable({ rows: data, columns })));
}
