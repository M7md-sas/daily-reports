// Small UI building blocks shared by the dashboard views.
import { t } from '../i18n.js';
import { el } from '../lib.js';

export function loadingBlock() {
  return el('div', { class: 'center-state' }, el('span', { class: 'spinner' }), el('p', { text: t('common.loading') }));
}

export function errorBlock(message, onRetry) {
  return el('div', { class: 'center-state' },
    el('p', { class: 'msg error', role: 'alert', text: message || t('err.load') }),
    onRetry ? el('button', { type: 'button', class: 'btn primary', onclick: onRetry, text: t('common.retry') }) : null);
}

export function viewHead(title, ...actions) {
  return el('div', { class: 'view-head' }, el('h1', { text: title }), el('div', { class: 'actions' }, actions));
}

export function field(label, control, cls = '') {
  return el('label', { class: `field ${cls}` }, el('span', { class: 'label', text: label }), control);
}

export function statCard(n, label, alt = false) {
  return el('div', { class: `stat${alt ? ' alt' : ''}` }, el('div', { class: 'n', text: String(n) }), el('div', { class: 'l', text: label }));
}

/**
 * columns: [{ label, cls, render: (row) => Node|string }]
 * On phones the table turns into stacked cards (labels come from data-label).
 */
export function dataTable({ columns, rows, onRowClick, empty }) {
  const table = el('table', { class: 'data stack' },
    el('thead', {}, el('tr', {}, columns.map((c) => el('th', { text: c.label })))));
  const tbody = el('tbody');
  if (!rows.length) {
    tbody.append(el('tr', {}, el('td', { class: 'empty-row', colspan: columns.length, text: empty ?? t('common.none') })));
  }
  rows.forEach((row) => {
    const tr = el('tr', onRowClick ? {
      class: 'click', tabindex: '0',
      onclick: (e) => { if (!e.target.closest('button, a, input, select')) onRowClick(row); },
      onkeydown: (e) => { if (e.key === 'Enter') onRowClick(row); },
    } : {});
    columns.forEach((c) => {
      const v = c.render(row);
      tr.append(el('td', { class: c.cls, 'data-label': c.label }, v instanceof Node ? v : String(v ?? '')));
    });
    tbody.append(tr);
  });
  table.append(tbody);
  return el('div', { class: 'table-wrap' }, table);
}

/** Searchable dropdown. items: [{ value, label, sub }] */
export function combo({ items, value = '', placeholder, onChange }) {
  const input = el('input', { class: 'input', type: 'search', placeholder, autocomplete: 'off', dir: 'auto', role: 'combobox', 'aria-expanded': 'false' });
  const list = el('ul', { class: 'combo-list', role: 'listbox', hidden: true });
  const root = el('div', { class: 'combo' }, input, list);
  let current = value;
  let active = -1;
  let shown = [];

  const labelOf = (v) => items.find((i) => i.value === v)?.label ?? '';
  input.value = labelOf(current);

  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.filter((i) => !q || i.label.toLowerCase().includes(q) || (i.sub ?? '').includes(q));
    list.replaceChildren(...shown.slice(0, 100).map((i, idx) => el('li', {
      role: 'option', 'aria-selected': String(idx === active),
      onmousedown: (e) => { e.preventDefault(); pick(i.value); },
    }, el('span', { dir: 'auto', text: i.label }), i.sub ? el('small', { text: i.sub }) : null)));
    list.hidden = !shown.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
  };
  const pick = (v) => {
    current = v;
    input.value = labelOf(v);
    list.hidden = true;
    active = -1;
    onChange(v);
  };

  input.addEventListener('focus', () => { input.select(); active = -1; render(); });
  input.addEventListener('input', () => { active = -1; render(); });
  input.addEventListener('blur', () => {
    list.hidden = true;
    if (!input.value.trim()) { if (current) pick(''); } else input.value = labelOf(current);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, shown.length - 1); render(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
    if (e.key === 'Enter' && active >= 0) { pick(shown[active].value); e.preventDefault(); }
    if (e.key === 'Escape') { list.hidden = true; input.blur(); }
  });
  root.setValue = (v) => { current = v; input.value = labelOf(v); };
  return root;
}

export function select(options, value, onChange) {
  const s = el('select', { class: 'select', onchange: (e) => onChange(e.target.value) });
  options.forEach((o) => {
    if (o.group) {
      const g = el('optgroup', { label: o.group });
      o.options.forEach((x) => g.append(new Option(x.label, x.value)));
      s.append(g);
    } else s.append(new Option(o.label, o.value));
  });
  s.value = value ?? '';
  return s;
}

export function progressBar() {
  const bar = el('span', { style: 'width:0%' });
  const text = el('div', { class: 'small muted' });
  const root = el('div', { class: 'progress-box', hidden: true }, el('div', { class: 'progress' }, bar), text);
  root.set = (fraction, label) => {
    root.hidden = false;
    bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    text.textContent = label ?? '';
  };
  root.hide = () => { root.hidden = true; };
  return root;
}
