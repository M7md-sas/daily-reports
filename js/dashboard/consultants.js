// Consultants (Section 8.5): registrations, last submission, Active toggle,
// plus the team access code (manager may change it) and releasing a phone.
import { t } from '../i18n.js?v=10';
import { el, fmtDate, fmtDateTime, errorKey } from '../lib.js?v=10';
import { loadingBlock, errorBlock, viewHead, dataTable, field } from './ui.js?v=10';

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
        box.append(el('span', { class: `pill ${Number(c.phones) > 0 ? '' : 'muted'}`, text: t(Number(c.phones) > 0 ? 'cs.bound' : 'cs.unbound') }));
        if (Number(c.phones) > 0) {
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
        }
        if (c.allow_new_device) {
          // Waiting for the consultant to register on the new phone: tell them on WhatsApp.
          box.append(el('span', { class: 'pill', text: t('cs.deviceAllowed') }), whatsappLink(c), el('button', {
            type: 'button', class: 'btn sm', text: t('cs.cancelAllow'),
            onclick: () => setAllow(c, false),
          }));
        } else {
          box.append(el('button', {
            type: 'button', class: 'btn sm', text: t('cs.allowDevice'),
            onclick: () => setAllow(c, true),
          }));
        }
        return box;
      },
    },
    {
      label: '',
      render: (c) => el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'btn sm', text: t('common.edit'), onclick: (e) => editRow(c, e.target.closest('tr')) }),
        el('button', { type: 'button', class: 'btn sm danger-outline', text: t('cs.delete'), onclick: (e) => removeConsultant(c, e.target) })),
    },
  ];

  // ---------------------------------------------------------------- row actions
  async function setAllow(c, allow) {
    const { error: err } = await ctx.sb.from('consultants').update({ allow_new_device: allow }).eq('id', c.id);
    if (err) { ctx.toast(t('err.generic')); return; }
    if (allow) ctx.toast(t('cs.allowedTell'));
    again();
  }

  function whatsappLink(c) {
    const link = new URL('./', location.href).href;
    const text = t('cs.waMessage', { name: c.full_name, link });
    return el('a', {
      class: 'btn sm wa', target: '_blank', rel: 'noopener noreferrer',
      href: `https://wa.me/${c.mobile.replace(/^\+/, '')}?text=${encodeURIComponent(text)}`,
      text: t('cs.waTell'),
    });
  }

  function editRow(c, tr) {
    const name = el('input', { class: 'input', value: c.full_name, maxlength: 100, dir: 'auto' });
    const mobile = el('input', { class: 'input', value: c.mobile.replace(/^\+966/, '0'), type: 'tel', dir: 'ltr', maxlength: 16 });
    const msg = el('span', { class: 'field-error' });
    const save = el('button', {
      type: 'button', class: 'btn sm primary', text: t('common.save'),
      onclick: async () => {
        save.disabled = true;
        const { error: err } = await ctx.sb.rpc('staff_update_consultant', {
          p_consultant_id: c.id, p_full_name: name.value, p_mobile: mobile.value,
        });
        save.disabled = false;
        if (err) { msg.textContent = t(errorKey(err)); return; }
        ctx.toast(t('cs.updated'));
        again();
      },
    });
    const cell = el('td', { colspan: tr.children.length },
      el('div', { class: 'inline-form' },
        field(t('col.name'), name),
        field(t('col.mobile'), mobile, 'narrow'),
        save,
        el('button', { type: 'button', class: 'btn sm', text: t('common.cancel'), onclick: again }),
        msg),
      el('p', { class: 'muted small', style: 'margin:6px 0 0', text: t('cs.editHint') }));
    tr.replaceChildren(cell);
    name.focus();
  }

  async function removeConsultant(c, btn) {
    const n = Number(c.reports);
    const question = n
      ? t('cs.deleteConfirmReports', { name: c.full_name, n })
      : t('cs.deleteConfirm', { name: c.full_name });
    if (!window.confirm(question)) return;
    if (n && window.prompt(t('cs.deleteTypeName', { name: c.full_name }))?.trim() !== c.full_name.trim()) return;
    btn.disabled = true;
    try {
      // Photo files first (they cannot be removed from SQL), then the rows.
      const names = [];
      for (let i = 0; ; i += 1000) {
        const { data: page, error: e1 } = await ctx.sb.rpc('consultant_object_names', { p_consultant_id: c.id }).range(i, i + 999);
        if (e1) throw e1;
        names.push(...page.map((o) => o.name));
        if (page.length < 1000) break;
      }
      for (let i = 0; i < names.length; i += 100) {
        const { error: e2 } = await ctx.sb.storage.from('report-photos').remove(names.slice(i, i + 100));
        if (e2) throw e2;
      }
      const { error: e3 } = await ctx.sb.rpc('delete_consultant', { p_consultant_id: c.id });
      if (e3) throw e3;
      ctx.toast(t('cs.deleted', { name: c.full_name }));
      again();
    } catch (e) {
      btn.disabled = false;
      ctx.toast(t('err.generic'));
    }
  }

  view.lastChild.replaceWith(el('div', {},
    el('h2', { class: 'section', style: 'margin-top:0', text: t('ad.teamCode') }),
    codePanel,
    el('h2', { class: 'section', text: t('nav.consultants') }),
    el('p', { class: 'muted small section-hint', text: t('cs.hint') }),
    dataTable({ rows: data, columns })));
}
