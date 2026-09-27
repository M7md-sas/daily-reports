// Dashboard shell: sign-in, role check, hash router, shared helpers.
import { t, applyI18n, bindLangToggle } from '../i18n.js?v=3';
import { createSupabase, el } from '../lib.js?v=3';
import * as today from './today.js?v=3';
import * as reports from './reports.js?v=3';
import * as detail from './detail.js?v=3';
import * as projects from './projects.js?v=3';
import * as consultants from './consultants.js?v=3';
import * as storage from './storage.js?v=3';
import * as admin from './admin.js?v=3';

const $ = (id) => document.getElementById(id);

// Read the URL before supabase-js consumes it: a password-recovery link arrives as
// #access_token=…&type=recovery, an expired one as #error=…&error_code=otp_expired.
const INITIAL_HASH = new URLSearchParams(location.hash.slice(1));
const ARRIVED_FOR_RECOVERY = INITIAL_HASH.get('type') === 'recovery';
const LINK_ERROR = INITIAL_HASH.get('error_code') || INITIAL_HASH.get('error');
if (LINK_ERROR) history.replaceState(null, '', location.pathname);

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
  ['loading', 'login', 'recovery', 'view'].forEach((s) => { $(s).hidden = s !== id; });
}

function showLogin(message, info) {
  ctx.user = null;
  ctx.role = null;
  $('nav').hidden = true;
  $('logoutBtn').hidden = true;
  $('changePwBtn').hidden = true;
  showOnly('login');
  const err = $('loginError');
  err.textContent = message ?? '';
  err.hidden = !message;
  $('loginInfo').textContent = info ?? '';
  $('loginInfo').hidden = !info;
}

// fromDashboard: a signed-in user changing their password (no email needed), so Cancel goes back.
function showRecovery(fromDashboard = false) {
  $('nav').hidden = true;
  $('logoutBtn').hidden = true;
  $('changePwBtn').hidden = true;
  $('recoveryError').hidden = true;
  $('recoveryCancel').hidden = !fromDashboard;
  showOnly('recovery');
  $('newPassword').focus();
}

$('changePwBtn').addEventListener('click', () => showRecovery(true));
$('recoveryCancel').addEventListener('click', () => {
  $('newPassword').value = '';
  $('newPassword2').value = '';
  if (ctx.user) enter(ctx.user);
});

// "Forgot password?" — emails a link that comes back to this page.
$('forgotBtn').addEventListener('click', async () => {
  const email = $('loginEmail').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return showLogin(t('auth.forgotNeedEmail'));
  $('forgotBtn').disabled = true;
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: `${location.origin}${location.pathname}`,
  });
  $('forgotBtn').disabled = false;
  if (error) {
    const limited = /rate|limit|seconds/i.test(error.message);
    return showLogin(t(limited ? 'auth.forgotLimit' : 'err.generic'));
  }
  showLogin(null, t('auth.forgotSent'));
});

$('recoveryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p1 = $('newPassword').value;
  const p2 = $('newPassword2').value;
  const err = $('recoveryError');
  const fail = (key) => { err.textContent = t(key); err.hidden = false; };
  if (p1.length < 8) return fail('auth.newTooShort');
  if (p1 !== p2) return fail('auth.newMismatch');
  $('recoveryBtn').disabled = true;
  const { data, error } = await sb.auth.updateUser({ password: p1 });
  $('recoveryBtn').disabled = false;
  if (error) {
    const weak = /weak|short|characters/i.test(error.message);
    const same = /different|same/i.test(error.message);
    return fail(same ? 'auth.newSame' : weak ? 'auth.newTooShort' : 'err.generic');
  }
  $('newPassword').value = '';
  $('newPassword2').value = '';
  toast(t('auth.newSaved'));
  enter(data.user);
});

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
  $('changePwBtn').hidden = false;
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
    if (event === 'PASSWORD_RECOVERY') showRecovery();
  });
  const { data: { session } } = await sb.auth.getSession();
  if (LINK_ERROR) showLogin(t(LINK_ERROR === 'otp_expired' ? 'auth.linkExpired' : 'auth.linkInvalid'));
  else if (ARRIVED_FOR_RECOVERY && session?.user) showRecovery();
  else if (session?.user) enter(session.user);
  else showLogin();
}

boot();
