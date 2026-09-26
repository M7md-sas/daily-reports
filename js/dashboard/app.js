// Dashboard shell: sign-in, role check, hash router, shared helpers.
import { t, applyI18n, bindLangToggle } from '../i18n.js';
import { createSupabase, el } from '../lib.js';
import * as today from './today.js';
import * as reports from './reports.js';
import * as detail from './detail.js';
import * as projects from './projects.js';
import * as consultants from './consultants.js';
import * as storage from './storage.js';
import * as admin from './admin.js';

const $ = (id) => document.getElementById(id);
const sb = createSupabase();

const ROUTES = { today, reports, report: detail, projects, consultants, storage, admin };

// Export libraries are large, so they load only when first needed.
const LIBS = {
  html2canvas: ['https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js', () => window.html2canvas],
  jspdf: ['https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js', () => window.jspdf],
  xlsx: ['https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js', () => window.XLSX],
  jszip: ['https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', () => window.JSZip],
  filesaver: ['https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js', () => window.saveAs],
};
const libPromises = {};
function loadLibs(...names) {
  return Promise.all(names.map((n) => {
    const [src, ready] = LIBS[n];
    if (ready()) return null;
    libPromises[n] ??= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { delete libPromises[n]; reject(new Error(`Could not load ${n}`)); };
      document.head.append(s);
    });
    return libPromises[n];
  }));
}

function toast(text) {
  const n = el('div', { class: 'toast', role: 'status', text });
  document.body.append(n);
  setTimeout(() => n.remove(), 3500);
}

function openLightbox(src) {
  const box = $('lightbox');
  box.querySelector('img').src = src;
  box.showModal();
}
$('lightbox').addEventListener('click', () => $('lightbox').close());

export const ctx = {
  sb, user: null, role: null, publicConfig: { access_mode: 'none' },
  toast, openLightbox, loadLibs,
  go: (hash) => { location.hash = hash; },
  state: {}, // per-view state that survives navigation (e.g. report filters)
};

// ---------------------------------------------------------------- auth

function showOnly(id) {
  ['loading', 'login', 'view'].forEach((s) => { $(s).hidden = s !== id; });
}

function showLogin(message) {
  ctx.user = null;
  ctx.role = null;
  $('nav').hidden = true;
  $('logoutBtn').hidden = true;
  showOnly('login');
  const err = $('loginError');
  err.textContent = message ?? '';
  err.hidden = !message;
}

async function enter(user) {
  showOnly('loading');
  const { data, error } = await sb.from('profiles').select('role, display_name').eq('user_id', user.id).maybeSingle();
  if (error) return showLogin(t('err.load'));
  if (!data) {
    await sb.auth.signOut();
    return showLogin(t('auth.noRole'));
  }
  ctx.user = user;
  ctx.role = data.role;
  const cfg = await sb.rpc('get_public_config');
  if (!cfg.error) ctx.publicConfig = cfg.data;
  $('navAdmin').hidden = ctx.role !== 'admin';
  $('nav').hidden = false;
  $('logoutBtn').hidden = false;
  showOnly('view');
  route();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn');
  btn.disabled = true;
  $('loginError').hidden = true;
  const { data, error } = await sb.auth.signInWithPassword({
    email: $('loginEmail').value.trim(),
    password: $('loginPassword').value,
  });
  btn.disabled = false;
  if (error) {
    const network = /fetch|network/i.test(error.message);
    return showLogin(t(network ? 'err.network' : 'auth.failed'));
  }
  $('loginPassword').value = '';
  enter(data.user);
});

$('logoutBtn').addEventListener('click', async () => {
  await sb.auth.signOut();
  showLogin();
});

// ---------------------------------------------------------------- router

let renderToken = 0;
let cleanup = null;

function route() {
  if (!ctx.user) return;
  const [name, ...rest] = (location.hash.slice(1) || 'today').split('/');
  let key = ROUTES[name] ? name : 'today';
  if (key === 'admin' && ctx.role !== 'admin') key = 'today';
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('on', a.dataset.route === (key === 'report' ? 'reports' : key));
  });
  cleanup?.();
  cleanup = null;
  const token = ++renderToken;
  const view = $('view');
  view.replaceChildren();
  window.scrollTo(0, 0);
  const out = ROUTES[key].render(ctx, view, rest.map(decodeURIComponent), () => token === renderToken);
  Promise.resolve(out).then((fn) => { if (typeof fn === 'function' && token === renderToken) cleanup = fn; });
}

async function boot() {
  window.__dcrBooted = true;
  applyI18n();
  bindLangToggle($('langToggle'));
  window.addEventListener('hashchange', route);
  window.addEventListener('langchange', route);
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && ctx.user) showLogin();
  });
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) enter(session.user);
  else showLogin();
}

boot();
