// Projects management (Section 8.4): add, edit, deactivate; promote "Other" names.
import { t } from '../i18n.js?v=9';
import { el, fmtDate, PROJECT_TYPES } from '../lib.js?v=9';
import { loadingBlock, errorBlock, viewHead, dataTable, select, field } from './ui.js?v=9';

export async function render(ctx, view, _params, isCurrent) {
  view.replaceChildren(viewHead(t('nav.projects')), loadingBlock());
  const [projs, others] = await Promise.all([
    ctx.sb.from('projects').select('id, name, type, is_active, created_at').order('type').order('name'),
    ctx.sb.rpc('other_project_names'),
  ]);
  if (!isCurrent()) return;
  if (projs.error || others.error) {
    view.lastChild.replaceWith(errorBlock(t('err.load'), () => render(ctx, view, _params, isCurrent)));
    return;
  }
  const again = () => render(ctx, view, _params, isCurrent);
  const typeOptions = PROJECT_TYPES.map((x) => ({ label: t(`type.${x}`), value: x }));

  // ---------------------------------------------------------------- add
  const nameIn = el('input', { class: 'input', maxlength: 150, dir: 'auto', required: true });
  let newType = PROJECT_TYPES[0];
  const addMsg = el('div', { class: 'msg error', hidden: true });
  const addForm = el('form', {
    class: 'panel inline-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      if (!name) return;
      const { error } = await ctx.sb.from('projects').insert({ name, type: newType });
      if (error) {
        addMsg.textContent = error.code === '23505' ? t('pj.dupe') : t('err.generic');
        addMsg.hidden = false;
        return;
      }
      ctx.toast(`✓ ${name}`);
      again();
    },
  },
  field(t('pj.name'), nameIn),
  field(t('pj.type'), select(typeOptions, newType, (v) => { newType = v; }), 'narrow'),
  el('button', { type: 'submit', class: 'btn primary', text: t('pj.add') }));

  // ---------------------------------------------------------------- list
  const list = dataTable({
    rows: projs.data,
    columns: [
      { label: t('col.name'), cls: 'name', render: (p) => el('span', { dir: 'auto', text: p.name }) },
      { label: t('col.type'), render: (p) => el('span', { class: 'pill', text: p.type }) },
      {
        label: t('col.status'),
        render: (p) => el('span', { class: `pill ${p.is_active ? '' : 'muted'}`, text: t(p.is_active ? 'common.active' : 'common.inactive') }),
      },
      { label: '', render: (p) => rowActions(p) },
    ],
  });

  function rowActions(p) {
    const box = el('div', { class: 'actions' });
    const edit = el('button', {
      type: 'button', class: 'btn sm', text: t('common.edit'),
      onclick: () => {
        const n = el('input', { class: 'input', value: p.name, maxlength: 150, dir: 'auto' });
        let ty = p.type;
        const err = el('span', { class: 'field-error' });
        box.replaceChildren(el('div', { class: 'inline-form' },
          n, select(typeOptions, ty, (v) => { ty = v; }),
          el('button', {
            type: 'button', class: 'btn sm primary', text: t('common.save'),
            onclick: async () => {
              const { error } = await ctx.sb.from('projects').update({ name: n.value.trim(), type: ty }).eq('id', p.id);
              if (error) { err.textContent = error.code === '23505' ? t('pj.dupe') : t('err.generic'); return; }
              again();
            },
          }),
          el('button', { type: 'button', class: 'btn sm', text: t('common.cancel'), onclick: again }),
          err));
        n.focus();
      },
    });
    const toggle = el('button', {
      type: 'button', class: 'btn sm', text: t(p.is_active ? 'pj.deactivate' : 'pj.activate'),
      onclick: async () => {
        toggle.disabled = true;
        const { error } = await ctx.sb.from('projects').update({ is_active: !p.is_active }).eq('id', p.id);
        if (error) { ctx.toast(t('err.generic')); toggle.disabled = false; return; }
        again();
      },
    });
    box.append(edit, toggle);
    return box;
  }

  // ---------------------------------------------------------------- "Other" names
  const othersTable = dataTable({
    rows: others.data,
    columns: [
      { label: t('col.type'), render: (o) => el('span', { class: 'pill', text: o.project_type }) },
      { label: t('col.name'), cls: 'name', render: (o) => el('span', { dir: 'auto', text: o.name }) },
      { label: t('col.reports'), cls: 'num', render: (o) => String(o.report_count) },
      { label: t('col.lastUsed'), cls: 'num', render: (o) => fmtDate(o.last_used) },
      { label: '', render: (o) => promoteCell(o) },
    ],
  });

  function promoteCell(o) {
    const box = el('div');
    const start = el('button', {
      type: 'button', class: 'btn sm primary', text: t('pj.promote'),
      onclick: () => {
        const relink = el('input', { type: 'checkbox', checked: true });
        box.replaceChildren(
          el('label', { class: 'toggle small' }, relink, t('pj.relink', { n: o.report_count })),
          el('div', { class: 'actions', style: 'margin-top:6px' },
            el('button', {
              type: 'button', class: 'btn sm primary', text: t('common.yes'),
              onclick: async (e) => {
                e.target.disabled = true;
                const { data, error } = await ctx.sb.rpc('promote_other_project', {
                  p_type: o.project_type, p_name: o.name, p_relink: relink.checked,
                });
                if (error) { ctx.toast(t('err.generic')); e.target.disabled = false; return; }
                ctx.toast(t('pj.promoted', { n: data.relinked }));
                again();
              },
            }),
            el('button', { type: 'button', class: 'btn sm', text: t('common.cancel'), onclick: () => box.replaceChildren(start) })));
      },
    });
    box.append(start);
    return box;
  }

  view.lastChild.replaceWith(el('div', {},
    addForm, addMsg,
    el('h2', { class: 'section', text: t('pj.list') }),
    list,
    el('h2', { class: 'section', text: t('pj.others') }),
    el('p', { class: 'muted small section-hint', text: t('pj.others.hint') }),
    othersTable));
}
