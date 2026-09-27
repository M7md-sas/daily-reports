// Consultant app (Section 7): registration + Submit Report.
import { CONFIG } from './config.js?v=4';
import { t, applyI18n, bindLangToggle } from './i18n.js?v=4';
import {
  createSupabase, normalizeMobile, fmtDate, fmtTime, uuid, errorKey, PROJECT_TYPES, sleep,
} from './lib.js?v=4';
import { sanitizeReportHtml } from './sanitize.js?v=4';
import { photoStore } from './idb.js?v=4';

const sb = createSupabase({ anonymous: true });
const $ = (id) => document.getElementById(id);

const LS = { me: 'dcr.me', draft: 'dcr.draft', projects: 'dcr.projects', config: 'dcr.config' };
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
  pending: null,       // { reportId, folder, submittedAt, photoIds, uploaded }
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
  window.__dcrBooted = true;
  applyI18n();
  bindLangToggle($('langToggle'));
  window.addEventListener('langchange', onLangChange);
  wireRegister();
  wireReport();

  if (S.me) {
    await enterReport();
    refreshRemote(); // update projects/config in the background
    return;
  }
  show('screenLoading');
  try {
    await refreshRemote(true);
    openRegister('register');
  } catch (e) {
    fatal(t(errorKey(e)));
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
    $('regCodeField').hidden = S.config.access_mode === 'none' || S.regMode === 'edit';
  } catch (e) {
    if (throwOnError) throw e;
  }
}

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
  $('regCodeField').hidden = edit || S.config.access_mode === 'none';
  $('regName').value = edit ? S.me.full_name : '';
  $('regMobile').value = edit ? S.me.mobile.replace(/^\+966/, '0') : '';
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
    const code = $('regCode').value.trim();
    if (name.length < 2) return showMsg($('regError'), t('err.invalid_name'));
    if (!mobile) return showMsg($('regError'), t('err.invalid_mobile'));
    if (S.regMode === 'register' && S.config.access_mode !== 'none' && !code) {
      return showMsg($('regError'), t('err.invalid_team_code'));
    }

    const btn = $('regSubmit');
    btn.disabled = true;
    showMsg($('regError'), '');
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
          p_full_name: name, p_mobile: mobile, p_team_code: code || null,
        });
        if (error) throw error;
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
      showMsg($('regError'), t(key));
    } finally {
      btn.disabled = false;
    }
  });
}

function forgetMe() {
  S.me = null;
  drop(LS.me);
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
      if (S.pending || S.busy) return;
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
  sel.disabled = !!S.pending;
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
  if (!files.length || S.pending) return;

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
    if (!S.pending) {
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
  if (S.pending || S.busy) return;
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
    S.pending = d.pending ?? null;
    setType(d.type);
    $('otherName').value = S.otherName;
    if (d.delta) quill.setContents(d.delta, 'silent');
  }
  if (S.pending) {
    // Keep only photos that still exist on this device.
    S.pending.photoIds = S.pending.photoIds.filter((id) => S.photos.some((p) => p.id === id));
  }
  renderProjects();
  renderThumbs();
  applyLock();

  const hasContent = (d && (quill.getText().trim() || d.type)) || S.photos.length;
  if (S.pending) $('pendingBox').hidden = false;
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
function applyLock() {
  const locked = !!S.pending;
  quill?.enable(!locked && !S.busy);
  $('otherName').disabled = locked;
  $('projectSelect').disabled = locked || !S.type;
  $('reportForm').setAttribute('aria-busy', String(locked || S.busy));
  $('submitBtn').textContent = locked ? t('common.retry') : t('rep.submit');
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

async function submit() {
  if (S.busy) return;
  showMsg($('submitError'), '');
  if (!S.pending && !validate()) return;
  if (S.photos.some((p) => p.busy)) {
    // Wait for compression to finish rather than dropping photos.
    progress(t('rep.photos.processing'), 0.02);
    while (S.photos.some((p) => p.busy)) await sleep(200);
  }

  S.busy = true;
  applyLock();
  $('submitBtn').disabled = true;
  try {
    if (!S.pending) {
      S.reportId ??= uuid();
      saveDraft();
      progress(t('prog.saving'), 0.05);
      const html = sanitizeReportHtml(quill.getSemanticHTML());
      const text = quill.getText().replace(/\n{3,}/g, '\n\n').trim();
      const photos = S.photos.filter((p) => p.blob);
      const { data, error } = await sb.rpc('submit_report', {
        p_report_id: S.reportId,
        p_consultant_id: S.me.consultant_id,
        p_device_token: S.me.device_token,
        p_project_type: S.type,
        p_project_id: S.projectId === 'other' ? null : S.projectId,
        p_project_other_name: S.projectId === 'other' ? S.otherName.trim() : null,
        p_body_html: html,
        p_body_text: text,
        p_photos_expected: photos.length,
      });
      if (error) throw error;
      S.pending = {
        reportId: data.report_id, folder: data.folder, submittedAt: data.submitted_at,
        photoIds: photos.map((p) => p.id), uploaded: [],
      };
      saveDraft();
      renderThumbs();
    }

    await uploadPhotos();

    progress(t('prog.finishing'), 0.97);
    const { data, error } = await sb.rpc('attach_photos', {
      p_report_id: S.pending.reportId,
      p_consultant_id: S.me.consultant_id,
      p_device_token: S.me.device_token,
    });
    if (error) throw error;
    if (data.photo_count < S.pending.photoIds.length) throw new Error('network: photos missing');

    const when = S.pending.submittedAt;
    await clearDraft();
    S.busy = false;
    resetForm();
    $('okDate').textContent = fmtDate(when);
    $('okTime').textContent = fmtTime(when);
    show('screenSuccess');
  } catch (e) {
    const key = errorKey(e);
    if (key === 'err.unknown_consultant' || key === 'err.device_not_recognized') {
      forgetMe();
      S.busy = false;
      openRegister('register');
      showMsg($('regError'), t(key));
      return;
    }
    if (key === 'err.invalid_project') {
      S.projectId = '';
      refreshRemote();
    }
    $('progressBox').hidden = true;
    $('pendingBox').hidden = !S.pending;
    showMsg($('submitError'), t(key));
    $('submitError').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } finally {
    S.busy = false;
    $('submitBtn').disabled = false;
    applyLock();
  }
}

async function uploadPhotos() {
  const p = S.pending;
  const total = p.photoIds.length;
  for (let i = 0; i < total; i++) {
    const id = p.photoIds[i];
    if (p.uploaded.includes(id)) continue;
    const photo = S.photos.find((x) => x.id === id);
    progress(t('prog.uploading', { i: i + 1, n: total }), 0.1 + 0.85 * (i / total));
    const path = `${p.folder}/${i + 1}.jpg`;
    const { error } = await sb.storage.from(CONFIG.PHOTO_BUCKET).upload(path, photo.blob, {
      contentType: 'image/jpeg', upsert: false, cacheControl: '31536000',
    });
    // Already uploaded by an earlier attempt whose response was lost: fine.
    if (error && !/already exists|duplicate|409/i.test(`${error.message} ${error.statusCode ?? ''}`)) {
      throw error;
    }
    p.uploaded.push(id);
    saveDraft();
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
