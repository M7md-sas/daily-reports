// Consultant app (Section 7): registration + Submit Report.
import { CONFIG } from './config.js?v=9';
import { t, applyI18n, bindLangToggle } from './i18n.js?v=9';
import {
  createSupabase, normalizeMobile, fmtDate, fmtTime, uuid, errorKey, PROJECT_TYPES, sleep,
} from './lib.js?v=9';
import { sanitizeReportHtml } from './sanitize.js?v=9';
import { photoStore } from './idb.js?v=9';

const sb = createSupabase({ anonymous: true });
const $ = (id) => document.getElementById(id);

const LS = { me: 'dcr.me', draft: 'dcr.draft', projects: 'dcr.projects', config: 'dcr.config', device: 'dcr.device' };

// Permanent random id for this phone, kept in two places and never cleared by sign-out.
// The server binds it to the first consultant who registers here, so one phone cannot
// be used to register a second name.
function deviceId() {
  const cookie = document.cookie.split('; ').find((c) => c.startsWith('dcr_device='))?.split('=')[1];
  let id = null;
  try { id = localStorage.getItem(LS.device); } catch { /* blocked */ }
  id ||= cookie || `${uuid()}${uuid()}`.replace(/-/g, '');
  try { localStorage.setItem(LS.device, id); } catch { /* blocked */ }
  document.cookie = `dcr_device=${id}; max-age=${60 * 60 * 24 * 3650}; path=/; SameSite=Strict; Secure`;
  return id;
}
const load = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } };
const drop = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

const S = {
  config: load(LS.config) ?? { access_mode: 'none' },
  me: load(LS.me),
  projects: load(LS.projects) ?? [],
  type: null,
  projectId: '',       // project uuid, 'other' or ''
  otherName: '',
  photos: [],          // { id, order, blob, url, busy }
  reportId: null,      // generated once per report, so retries are idempotent
  sent: null,          // frozen payload once sent: { html, type, projectId, otherName, slots }
  pending: null,       // { reportId, folder, submittedAt, expected, slots: [{ id, n }], uploaded: [n] }
  busy: false,
  regMode: 'register', // 'register' | 'edit'
};

let quill;

// ---------------------------------------------------------------- screens

const SCREENS = ['screenLoading', 'screenFatal', 'screenRegister', 'screenReport', 'screenSuccess'];
function show(id) {
  SCREENS.forEach((s) => { $(s).hidden = s !== id; });
  window.scrollTo(0, 0);
}

function showMsg(node, text, kind) {
  node.textContent = text;
  if (kind) node.className = `msg ${kind}`;
  node.hidden = !text;
}

// ---------------------------------------------------------------- boot

async function boot() {
  applyI18n();
  if (!window.Quill || !window.DOMPurify || !window.imageCompression || !window.supabase) {
    window.__dcrBooted = true;
    fatal(t('err.network'));
    return;
  }
  bindLangToggle($('langToggle'));
  window.addEventListener('langchange', onLangChange);
  wireRegister();
  wireReport();

  try {
    if (S.me) {
      await enterReport();
      refreshRemote(); // update projects/config in the background
      checkBinding();
      return;
    }
    show('screenLoading');
    await refreshRemote(true);
    openRegister('register');
  } catch (e) {
    fatal(t(errorKey(e)));
  } finally {
    window.__dcrBooted = true;
  }
}

async function refreshRemote(throwOnError = false) {
  try {
    const [cfg, pj] = await Promise.all([
      sb.rpc('get_public_config'),
      sb.from('projects').select('id,name,type').eq('is_active', true).order('name'),
    ]);
    if (cfg.error) throw cfg.error;
    if (pj.error) throw pj.error;
    S.config = cfg.data;
    S.projects = pj.data;
    save(LS.config, S.config);
    save(LS.projects, S.projects);
    renderProjects();
    syncCodeField();
  } catch (e) {
    if (throwOnError) throw e;
  }
}

// The admin can switch the team code on or off at any time, so the page re-checks
// before registering and whenever it comes back to the screen.
async function refreshConfig() {
  const { data, error } = await sb.rpc('get_public_config');
  if (error) return;
  S.config = data;
  save(LS.config, S.config);
  syncCodeField();
}

/** Shows the team-code field only when the code is required; hiding it also clears it. */
function syncCodeField() {
  const hide = S.config.access_mode === 'none' || S.regMode === 'edit';
  $('regCodeField').hidden = hide;
  if (hide) $('regCode').value = '';
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshRemote();
});

function fatal(text) {
  $('fatalMsg').textContent = text;
  show('screenFatal');
}
$('fatalRetry').addEventListener('click', () => location.reload());

// ---------------------------------------------------------------- registration / edit details

function openRegister(mode) {
  S.regMode = mode;
  const edit = mode === 'edit';
  $('regTitle').dataset.i18n = edit ? 'edit.title' : 'reg.title';
  $('regIntro').hidden = edit;
  $('regCancel').hidden = !edit;
  syncCodeField();
  $('regName').value = edit ? S.me.full_name : '';
  $('regMobile').value = edit ? S.me.mobile.replace(/^\+966/, '0') : '';
  $('regMobile').readOnly = edit;
  $('regMobileHint').dataset.i18n = edit ? 'edit.mobileHint' : 'reg.mobile.hint';
  $('regCode').value = '';
  showMsg($('regError'), '');
  applyI18n($('screenRegister'));
  show('screenRegister');
}

function wireRegister() {
  $('regCancel').addEventListener('click', () => show('screenReport'));
  $('regForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = $('regName').value.trim();
    const mobile = normalizeMobile($('regMobile').value);
    if (name.length < 2) return showMsg($('regError'), t('err.invalid_name'));
    if (!mobile) return showMsg($('regError'), t('err.invalid_mobile'));

    const btn = $('regSubmit');
    btn.disabled = true;
    showMsg($('regError'), '');
    if (S.regMode === 'register') {
      const wasHidden = $('regCodeField').hidden;
      await refreshConfig();
      if (!$('regCodeField').hidden && (wasHidden || !$('regCode').value.trim())) {
        btn.disabled = false;
        $('regCode').focus();
        return showMsg($('regError'), t('reg.codeNeeded'));
      }
    }
    const code = $('regCode').value.trim();
    try {
      if (S.regMode === 'edit') {
        const { data, error } = await sb.rpc('update_my_details', {
          p_consultant_id: S.me.consultant_id, p_device_token: S.me.device_token,
          p_full_name: name, p_mobile: mobile,
        });
        if (error) throw error;
        S.me = { ...S.me, full_name: data.full_name, mobile: data.mobile };
        save(LS.me, S.me);
        await enterReport();
        notice(t('edit.saved'), 'ok');
      } else {
        const { data, error } = await sb.rpc('register_consultant', {
          p_full_name: name, p_mobile: mobile, p_team_code: code || null, p_device_id: deviceId(),
        });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        S.me = {
          consultant_id: data.consultant_id, full_name: data.full_name,
          mobile: data.mobile, device_token: data.device_token,
        };
        save(LS.me, S.me);
        await enterReport();
        if (!data.is_new && data.full_name !== name) notice(t('reg.existing', { name: data.full_name }), 'info');
      }
    } catch (e) {
      const key = errorKey(e);
      if (key === 'err.device_not_recognized') {
        forgetMe();
        openRegister('register');
      }
      if (key === 'err.invalid_team_code') {
        await refreshConfig();
        if (!$('regCodeField').hidden) $('regCode').focus();
      }
      showMsg($('regError'), t(key));
    } finally {
      btn.disabled = false;
    }
  });
}

// Ties this phone to the signed-in consultant (for accounts made before phone binding),
// and signs out if the manager released the phone or it belongs to someone else.
async function checkBinding() {
  if (!S.me) return;
  const { data, error } = await sb.rpc('bind_device', {
    p_consultant_id: S.me.consultant_id, p_device_token: S.me.device_token, p_device_id: deviceId(),
  });
  if (error && errorKey(error) !== 'err.device_bound_other') return; // offline etc.: try next time
  if (!error && data === 'ok') return;
  if (S.pending || S.sent || S.busy) return; // never interrupt an unfinished submission
  forgetMe(); // the draft stays on the phone and comes back after registering again
  openRegister('register');
  showMsg($('regError'), t(error ? 'err.device_bound_other' : 'reg.released'));
}

function forgetMe() {
  S.me = null;
  drop(LS.me);
}

// Sign out on this phone: forget the identity and any unsent draft, so the next
// person using the phone starts clean. Reports already sent stay on the server.
async function logout() {
  if (S.busy) return;
  const hasDraft = !!(S.pending || S.sent || S.photos.length || quill?.getText().trim());
  let question = t('logout.confirm');
  if (S.pending || S.sent) question += `\n\n${t('logout.pending')}`;
  else if (hasDraft) question += `\n\n${t('logout.draft')}`;
  question += `\n\n${t('logout.deviceLock')}`;
  if (!window.confirm(question)) return;
  await clearDraft();
  if (quill) resetForm();
  forgetMe();
  openRegister('register');
}

// ---------------------------------------------------------------- report screen

function notice(text, kind) {
  showMsg($('noticeBox'), text, kind);
}

async function enterReport() {
  $('idName').textContent = S.me.full_name;
  $('idMobile').textContent = S.me.mobile;
  showMsg($('noticeBox'), '');
  initEditor();
  renderProjects();
  show('screenReport');
  await restoreDraft();
}

function initEditor() {
  if (quill) return;
  quill = new window.Quill('#editor', {
    theme: 'snow',
    placeholder: t('rep.body.ph'),
    // Only the formats listed in Section 7.3 — this also drops pasted images.
    formats: ['header', 'size', 'bold', 'italic', 'underline', 'color', 'list'],
    modules: {
      toolbar: [
        [{ header: [2, 3, false] }, { size: ['small', false, 'large', 'huge'] }],
        ['bold', 'italic', 'underline', { color: [] }],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['clean'],
      ],
      uploader: { mimetypes: [] },
    },
  });
  let timer;
  quill.on('text-change', () => {
    clearTimeout(timer);
    timer = setTimeout(saveDraft, 400);
    hideErr('errBody');
  });
}

function wireReport() {
  document.querySelectorAll('.type-btn').forEach((b) => {
    b.addEventListener('click', () => {
      if (locked() || S.busy) return;
      setType(b.dataset.type);
      saveDraft();
    });
  });
  $('projectSelect').addEventListener('change', (e) => {
    S.projectId = e.target.value;
    $('otherField').hidden = S.projectId !== 'other';
    hideErr('errProject');
    if (S.projectId === 'other') $('otherName').focus();
    saveDraft();
  });
  $('otherName').addEventListener('input', (e) => {
    S.otherName = e.target.value;
    hideErr('errOther');
    saveDraft();
  });
  $('photoCamera').addEventListener('change', onPhotosPicked);
  $('photoGallery').addEventListener('change', onPhotosPicked);
  $('reportForm').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  $('editDetails').addEventListener('click', () => openRegister('edit'));
  $('logoutBtn').addEventListener('click', logout);
  $('finishBtn').addEventListener('click', finishWithoutRemaining);
  $('anotherBtn').addEventListener('click', () => {
    resetForm();
    show('screenReport');
  });
}

function setType(type) {
  S.type = PROJECT_TYPES.includes(type) ? type : null;
  document.querySelectorAll('.type-btn').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.type === S.type));
  });
  // A project from another type is no longer valid.
  const p = S.projects.find((x) => x.id === S.projectId);
  if (p && p.type !== S.type) S.projectId = '';
  hideErr('errType');
  renderProjects();
}

function renderProjects() {
  const sel = $('projectSelect');
  if (!sel) return;
  sel.innerHTML = '';
  const hint = $('projectHint');
  if (!S.type) {
    sel.disabled = true;
    sel.append(new Option(t('rep.project.pickType'), ''));
    hint.textContent = '';
    $('otherField').hidden = true;
    return;
  }
  sel.disabled = locked() || S.busy;
  const list = S.projects.filter((p) => p.type === S.type);
  sel.append(new Option(t('rep.project.choose'), ''));
  list.forEach((p) => sel.append(new Option(p.name, p.id)));
  sel.append(new Option(t('rep.project.other'), 'other'));
  if (S.projectId && S.projectId !== 'other' && !list.some((p) => p.id === S.projectId)) S.projectId = '';
  sel.value = S.projectId;
  hint.textContent = list.length ? '' : t('rep.project.none');
  $('otherField').hidden = S.projectId !== 'other';
}

// ---------------------------------------------------------------- photos

async function onPhotosPicked(ev) {
  const input = ev.target;
  const files = [...input.files];
  input.value = '';
  if (!files.length || locked() || S.busy) return;

  const room = CONFIG.MAX_PHOTOS - S.photos.length;
  $('photoHint').textContent = files.length > room ? t('rep.photos.max', { n: CONFIG.MAX_PHOTOS }) : '';
  const accepted = files.slice(0, Math.max(0, room));

  const items = accepted.map((file, i) => ({ id: uuid(), order: Date.now() + i, busy: true, file }));
  S.photos.push(...items);
  renderThumbs();

  for (const item of items) {
    try {
      const blob = await window.imageCompression(item.file, {
        maxWidthOrHeight: CONFIG.PHOTO_MAX_SIDE,
        maxSizeMB: CONFIG.PHOTO_MAX_MB,
        fileType: 'image/jpeg',
        initialQuality: 0.8,
        useWebWorker: true,
        libURL: new URL('vendor/browser-image-compression.js', location.href).href,
      });
      if (!S.photos.includes(item)) continue; // removed while compressing
      item.blob = blob;
      item.url = URL.createObjectURL(blob);
      item.busy = false;
      delete item.file;
      await photoStore.put({ id: item.id, order: item.order, blob });
    } catch {
      S.photos = S.photos.filter((p) => p !== item);
      $('photoHint').textContent = t('rep.photos.failed');
    }
    renderThumbs();
  }
}

function renderThumbs() {
  const ul = $('thumbs');
  ul.innerHTML = '';
  S.photos.forEach((p, i) => {
    const li = document.createElement('li');
    if (p.url) {
      const img = new Image();
      img.src = p.url;
      img.alt = '';
      li.append(img);
    }
    if (p.busy) {
      const b = document.createElement('div');
      b.className = 'busy';
      b.innerHTML = `<div><span class="spinner"></span><div>${t('rep.photos.processing')}</div></div>`;
      li.append(b);
    }
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);
    li.append(num);
    if (!locked()) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'rm';
      rm.textContent = '×';
      rm.setAttribute('aria-label', t('rep.photos.remove'));
      rm.addEventListener('click', () => removePhoto(p));
      li.append(rm);
    }
    ul.append(li);
  });
}

function removePhoto(p) {
  if (locked() || S.busy) return;
  S.photos = S.photos.filter((x) => x !== p);
  if (p.url) URL.revokeObjectURL(p.url);
  photoStore.remove(p.id);
  renderThumbs();
}

// ---------------------------------------------------------------- draft

function saveDraft() {
  if (!quill) return;
  save(LS.draft, {
    type: S.type,
    projectId: S.projectId,
    otherName: S.otherName,
    delta: quill.getContents(),
    reportId: S.reportId,
    sent: S.sent,
    pending: S.pending,
  });
}

async function restoreDraft() {
  const d = load(LS.draft);
  const stored = (await photoStore.all()).sort((a, b) => a.order - b.order);
  S.photos.forEach((p) => p.url && URL.revokeObjectURL(p.url));
  S.photos = stored.map((r) => ({ id: r.id, order: r.order, blob: r.blob, url: URL.createObjectURL(r.blob), busy: false }));

  if (d) {
    S.projectId = d.projectId ?? '';
    S.otherName = d.otherName ?? '';
    S.reportId = d.reportId ?? null;
    S.sent = d.sent ?? null;
    S.pending = d.pending?.slots ? d.pending : null; // drafts from older versions restart cleanly
    if (d.pending && !d.pending.slots) S.sent = null;
    setType(d.type);
    $('otherName').value = S.otherName;
    if (d.delta) quill.setContents(d.delta, 'silent');
  }
  renderProjects();
  renderThumbs();
  applyLock();

  const hasContent = (d && (quill.getText().trim() || d.type)) || S.photos.length;
  if (S.pending || S.sent) $('pendingBox').hidden = false;
  else if (hasContent) notice(t('rep.draftRestored'), 'info');
}

async function clearDraft() {
  drop(LS.draft);
  await photoStore.clear();
}

function resetForm() {
  S.photos.forEach((p) => p.url && URL.revokeObjectURL(p.url));
  S.photos = [];
  S.type = null;
  S.projectId = '';
  S.otherName = '';
  S.reportId = null;
  S.sent = null;
  S.pending = null;
  quill.setContents([], 'silent');
  $('otherName').value = '';
  $('photoHint').textContent = '';
  showMsg($('noticeBox'), '');
  showMsg($('submitError'), '');
  $('pendingBox').hidden = true;
  $('progressBox').hidden = true;
  setType(null);
  renderThumbs();
  applyLock();
}

// Once the report row exists on the server, its text can no longer change —
// only the remaining photo uploads are retried.
function locked() {
  return !!(S.pending || S.sent);
}

function applyLock() {
  const lock = locked();
  quill?.enable(!lock && !S.busy);
  $('otherName').disabled = lock || S.busy;
  $('projectSelect').disabled = lock || S.busy || !S.type;
  $('photoCamera').disabled = lock || S.busy;
  $('photoGallery').disabled = lock || S.busy;
  $('reportForm').setAttribute('aria-busy', String(lock || S.busy));
  $('submitBtn').textContent = lock ? t('common.retry') : t('rep.submit');
  $('finishBtn').hidden = !S.pending || S.busy;
}

// ---------------------------------------------------------------- submit

function showErr(id, key) {
  const n = $(id);
  n.textContent = t(key);
  n.hidden = false;
}
function hideErr(id) {
  $(id).hidden = true;
}

function validate() {
  let first = null;
  const fail = (id, key, focus) => { showErr(id, key); first ??= focus; };
  if (!S.type) fail('errType', 'val.type', $('typeField'));
  else if (!S.projectId) fail('errProject', 'val.project', $('projectSelect'));
  else if (S.projectId === 'other' && !S.otherName.trim()) fail('errOther', 'val.otherName', $('otherName'));
  if (!quill.getText().trim()) fail('errBody', 'val.body', quill.root);
  if (first) {
    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    first.focus?.({ preventScroll: true });
  }
  return !first;
}

function progress(text, fraction) {
  $('progressBox').hidden = false;
  $('progressText').textContent = text;
  $('progressBar').style.width = `${Math.round(fraction * 100)}%`;
}

// Submission has three stages, each saved in the draft so a reload or lost reply resumes:
//  1. S.sent    — the report was sent once. From here the form is frozen, and retries send
//                 exactly the same payload (the server returns the stored report).
//  2. S.pending — the server confirmed the report; its photo slots are fixed (slot n → n.jpg).
//  3. attach    — the server registers whatever photos arrived.
async function submit() {
  if (S.busy) return;
  showMsg($('submitError'), '');
  if (!S.pending && !S.sent && !validate()) return;

  S.busy = true; // before waiting, so a second tap cannot start a parallel submission
  applyLock();
  $('submitBtn').disabled = true;
  try {
    if (S.photos.some((p) => p.busy)) {
      // Wait for compression to finish rather than dropping photos.
      progress(t('rep.photos.processing'), 0.02);
      while (S.photos.some((p) => p.busy)) await sleep(200);
    }

    if (!S.pending) {
      if (!S.sent) {
        const photos = S.photos.filter((p) => p.blob);
        S.reportId ??= uuid();
        S.sent = {
          html: sanitizeReportHtml(quill.getSemanticHTML()),
          type: S.type,
          projectId: S.projectId === 'other' ? null : S.projectId,
          otherName: S.projectId === 'other' ? S.otherName.trim() : null,
          slots: photos.map((p, i) => ({ id: p.id, n: i + 1 })),
        };
        saveDraft();
        applyLock();
        renderThumbs();
      }
      progress(t('prog.saving'), 0.05);
      const { data, error } = await sb.rpc('submit_report', {
        p_report_id: S.reportId,
        p_consultant_id: S.me.consultant_id,
        p_device_token: S.me.device_token,
        p_project_type: S.sent.type,
        p_project_id: S.sent.projectId,
        p_project_other_name: S.sent.otherName,
        p_body_html: S.sent.html,
        p_body_text: null,
        p_photos_expected: S.sent.slots.length,
      });
      if (error) throw error;
      S.pending = {
        reportId: data.report_id, folder: data.folder, submittedAt: data.submitted_at,
        expected: data.photos_expected,
        // Only the slots the server accepted (it keeps the first submission's count).
        slots: S.sent.slots.filter((s) => s.n <= data.photos_expected),
        uploaded: [],
      };
      saveDraft();
    }

    await uploadPhotos();
    await finish(false);
  } catch (e) {
    const key = uploadRefused(e) ? 'err.upload_refused' : errorKey(e);
    if (key === 'err.unknown_consultant' || key === 'err.device_not_recognized') {
      forgetMe();
      S.busy = false;
      openRegister('register');
      showMsg($('regError'), t(key));
      return;
    }
    if (key === 'err.invalid_project' || key === 'err.invalid_project_type' || key === 'err.bad_html'
        || key === 'err.empty_report' || key === 'err.daily_limit') {
      // The server refused the report itself: unfreeze the form so it can be corrected.
      S.sent = null;
      S.reportId = null;
      saveDraft();
      if (key === 'err.invalid_project') { S.projectId = ''; refreshRemote(); }
    }
    $('progressBox').hidden = true;
    showMsg($('submitError'), t(key));
    $('submitError').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } finally {
    S.busy = false;
    $('submitBtn').disabled = false;
    applyLock();
  }
}

function uploadRefused(e) {
  return /row-level security|unauthorized|403/i.test(`${e?.message ?? ''} ${e?.statusCode ?? ''} ${e?.error ?? ''}`);
}

async function uploadPhotos() {
  const p = S.pending;
  const todo = p.slots.filter((s) => !p.uploaded.includes(s.n));
  for (let i = 0; i < todo.length; i++) {
    const slot = todo[i];
    const photo = S.photos.find((x) => x.id === slot.id);
    if (!photo?.blob) continue; // lost from this phone's storage: reported at the end
    progress(t('prog.uploading', { i: p.uploaded.length + 1, n: p.slots.length }), 0.1 + 0.85 * (p.uploaded.length / Math.max(1, p.slots.length)));
    const { error } = await sb.storage.from(CONFIG.PHOTO_BUCKET).upload(`${p.folder}/${slot.n}.jpg`, photo.blob, {
      contentType: 'image/jpeg', upsert: false, cacheControl: '31536000',
    });
    // Already uploaded by an earlier attempt whose reply was lost: fine.
    if (error && !/already exists|duplicate|409/i.test(`${error.message} ${error.statusCode ?? ''}`)) {
      throw error;
    }
    p.uploaded.push(slot.n);
    saveDraft();
  }
}

/**
 * Registers the uploaded photos and shows the success screen.
 * force=false: only when every expected photo arrived (otherwise throws so Retry stays).
 * force=true:  "Finish without the remaining photos" — accept whatever is there.
 */
async function finish(force) {
  progress(t('prog.finishing'), 0.97);
  const p = S.pending;
  const { data, error } = await sb.rpc('attach_photos', {
    p_report_id: p.reportId, p_consultant_id: S.me.consultant_id, p_device_token: S.me.device_token,
  });
  if (error && !(force && /unknown_report/.test(error.message))) throw error;
  const count = data?.photo_count ?? 0;
  const missingLocally = p.slots.some((s) => !S.photos.some((x) => x.id === s.id && x.blob) && !p.uploaded.includes(s.n));
  if (!force && count < p.expected) {
    throw new Error(missingLocally ? 'photos_missing_locally' : 'network: photos missing');
  }
  const when = p.submittedAt;
  const short = Math.max(0, p.expected - count);
  await clearDraft();
  S.busy = false;
  resetForm();
  $('okDate').textContent = fmtDate(when);
  $('okTime').textContent = fmtTime(when);
  showMsg($('okWarn'), short ? t('ok.photosShort', { n: short }) : '', 'warn');
  show('screenSuccess');
}

async function finishWithoutRemaining() {
  if (S.busy || !S.pending) return;
  if (!window.confirm(t('pending.finishConfirm'))) return;
  S.busy = true;
  applyLock();
  try {
    await finish(true);
  } catch (e) {
    $('progressBox').hidden = true;
    showMsg($('submitError'), t(errorKey(e)));
  } finally {
    S.busy = false;
    applyLock();
  }
}

// ---------------------------------------------------------------- language

function onLangChange() {
  if (quill) quill.root.dataset.placeholder = t('rep.body.ph');
  renderProjects();
  renderThumbs();
  applyLock();
  ['errType', 'errProject', 'errOther', 'errBody'].forEach(hideErr);
  if (!$('regIntro').hidden || S.regMode === 'register') applyI18n($('screenRegister'));
}

boot();
