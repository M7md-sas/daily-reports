// Dashboard shell: sign-in, role check, hash router, shared helpers.
import { t, applyI18n, bindLangToggle } from '../i18n.js?v=10';
import { createSupabase, el } from '../lib.js?v=10';
import * as today from './today.js?v=10';
import * as reports from './reports.js?v=10';
import * as detail from './detail.js?v=10';
import * as projects from './projects.js?v=10';
import * as consultants from './consultants.js?v=10';
import * as storage from './storage.js?v=10';
import * as admin from './admin.js?v=10';

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
  html2canvas: ['vendor/html2canvas.min.js', () => window.html2canvas],
  jspdf: ['vendor/jspdf.umd.min.js', () => window.jspdf],
  xlsx: ['vendor/xlsx.full.min.js', () => window.XLSX],
  jszip: ['vendor/jszip.min.js', () => window.JSZip],
  filesaver: ['vendor/FileSaver.min.js', () => window.saveAs],
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

// Eye button inside every password field: show / hide what was typed.
const EYE = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7zm0 11.5A4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 0 1 0 9zm0-2.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M3.3 2 2 3.3l3.2 3.2C3.6 7.8 2.5 9.6 2 12c1 2.5 5 7 10 7 1.9 0 3.6-.6 5-1.5l3.7 3.7L22 20 3.3 2zM12 16.5A4.5 4.5 0 0 1 7.5 12c0-.8.2-1.6.6-2.2l1.9 1.9a2 2 0 0 0 2.3 2.3l1.9 1.9c-.6.4-1.4.6-2.2.6zM12 5c-1.3 0-2.6.3-3.7.8l2.1 2.1c.5-.2 1-.4 1.6-.4a4.5 4.5 0 0 1 4.5 4.5c0 .6-.1 1.1-.4 1.6l3 3c1.4-1.2 2.4-2.6 2.9-3.6-1-2.5-5-8-10-8z"/></svg>';
function setReveal(input, btn, show) {
  input.type = show ? 'text' : 'password';
  btn.innerHTML = show ? EYE_OFF : EYE;
  btn.setAttribute('aria-label', t(show ? 'auth.hidePw' : 'auth.showPw'));
  btn.setAttribute('aria-pressed', String(show));
}
document.querySelectorAll('input[type="password"]').forEach((input) => {
  const wrap = el('span', { class: 'pw-wrap' });
  input.replaceWith(wrap);
  const btn = el('button', { type: 'button', class: 'pw-eye' });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    setReveal(input, btn, input.type === 'password');
    input.focus();
  });
  wrap.append(input, btn);
  setReveal(input, btn, false);
});
function hidePasswords() {
  document.querySelectorAll('.pw-wrap').forEach((w) => setReveal(w.querySelector('input'), w.querySelector('.pw-eye'), false));
}
window.addEventListener('langchange', hidePasswords);

function showOnly(id) {
  hidePasswords();
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
  // From the dashboard the current password is required, so a stolen session alone
  // cannot lock the owner out. From an emailed recovery link it is not (it was forgotten).
  $('currentPasswordField').hidden = !fromDashboard;
  $('currentPassword').value = '';
  recoveryFromDashboard = fromDashboard;
  showOnly('recovery');
  (fromDashboard ? $('currentPassword') : $('newPassword')).focus();
}
let recoveryFromDashboard = false;

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
  if (recoveryFromDashboard) {
    const { error: wrong } = await sb.auth.signInWithPassword({
      email: ctx.user.email, password: $('currentPassword').value,
    });
    if (wrong) {
      $('recoveryBtn').disabled = false;
      return fail('auth.currentWrong');
    }
  }
  const { data, error } = await sb.auth.updateUser({ password: p1 });
  $('recoveryBtn').disabled = false;
  if (error) {
    const weak = /weak|short|characters/i.test(error.message);
    const same = /different|same/i.test(error.message);
    return fail(same ? 'auth.newSame' : weak ? 'auth.newTooShort' : 'err.generic');
  }
  $('newPassword').value = '';
  $('newPassword2').value = '';
  $('currentPassword').value = '';
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
  // Older versions kept the session in localStorage, readable by every site on the shared
  // github.io origin; remove it (the session now lives in this tab only).
  try { localStorage.removeItem('dcr-dashboard-auth'); } catch { /* ignore */ }
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
