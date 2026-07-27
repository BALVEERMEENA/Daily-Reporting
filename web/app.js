// Daily Reporting — pure client-side Firebase app (Auth + Firestore).
// All access control is enforced by firestore.rules; this file is the UI and
// the data calls. No backend server is involved.
//
// Users:
//  - Every user has a name and an admin-chosen Unique ID used for reporting.
//  - A user optionally has a login (email + password) for dashboard access.
//    Login users' docs are keyed by their Firebase Auth uid; report-only users
//    get an auto id and never sign in.
//  - codes/{uniqueId} is a public-by-id lookup: it maps the Unique ID to the
//    user and the questionnaires assigned to them, so reporting needs only the id.

import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc,
  updateDoc, deleteDoc, query, where, serverTimestamp, writeBatch,
  arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

/* ------------------------------------------------------------------ *
 * Firebase init
 * ------------------------------------------------------------------ */
const CONFIG_READY = !String(firebaseConfig.apiKey || '').startsWith('REPLACE');
const app = CONFIG_READY ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */
const $ = (s, r = document) => r.querySelector(s);
const root = () => $('#root');
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
};
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  setTimeout(() => t.classList.add('hidden'), 3200);
}
function fmtDate(v) {
  if (!v) return '';
  const d = v.toDate ? v.toDate() : new Date(v);
  return isNaN(d) ? '' : d.toLocaleString();
}
function millis(v) { return v && v.toDate ? v.toDate().getTime() : (v ? new Date(v).getTime() : 0); }
function friendlyError(err) {
  const c = (err && err.code) || '';
  if (c === 'auth/invalid-credential' || c === 'auth/wrong-password' || c === 'auth/user-not-found')
    return 'Invalid email or password.';
  if (c === 'auth/email-already-in-use') return 'A user with that email already exists.';
  if (c === 'auth/weak-password') return 'Password should be at least 6 characters.';
  if (c === 'auth/invalid-email') return 'That email address is not valid.';
  if (c === 'permission-denied') return 'You do not have permission to do that.';
  return (err && err.message) || 'Something went wrong.';
}
const normId = (s) => String(s || '').trim().toUpperCase();

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
const state = { user: null, page: null, notifications: [] };

/* ------------------------------------------------------------------ *
 * Firestore data layer
 * ------------------------------------------------------------------ */
const colRef = (name) => collection(db, name);
const snapList = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
async function getAll(name) { return snapList(await getDocs(colRef(name))); }
async function getWhere(name, field, value) {
  return snapList(await getDocs(query(colRef(name), where(field, '==', value))));
}
const byCreatedDesc = (a, b) => millis(b.createdAt) - millis(a.createdAt);
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));

/* ---- department hierarchy helpers ---- */
// Compute each department's ancestor path (root-first, including itself) from
// the parentId graph. Returns { deptId: [ancestorIds..., self] }.
function computePaths(depts) {
  const byId = Object.fromEntries(depts.map((d) => [d.id, d]));
  const pathOf = (id, seen) => {
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const d = byId[id];
    if (!d) return [];
    return d.parentId ? [...pathOf(d.parentId, seen), id] : [id];
  };
  const res = {};
  for (const d of depts) res[d.id] = pathOf(d.id, new Set());
  return res;
}
// The stored path for a department (falls back to computing from the list).
function deptPathOf(deptId, depts) {
  if (!deptId) return [];
  const d = (depts || []).find((x) => x.id === deptId);
  if (d && Array.isArray(d.path) && d.path.length) return d.path;
  return computePaths(depts || [])[deptId] || [deptId];
}
function deptDepth(d) { return (Array.isArray(d.path) ? d.path.length : 1) - 1; }
function deptName(depts, id) { return (depts.find((d) => d.id === id) || {}).name || '—'; }

// Department heads see their whole subtree: any record whose deptPath contains
// their own department id.
async function getSubtree(name) {
  return snapList(await getDocs(query(colRef(name), where('deptPath', 'array-contains', state.user.departmentId))));
}
async function listUsers() {
  const rows = state.user.role === 'admin' ? await getAll('users') : await getSubtree('users');
  return rows.sort(byName);
}
async function listDepartments() { return (await getAll('departments')).sort(byName); }
async function listQuestionnaires() {
  const rows = state.user.role === 'admin' ? await getAll('questionnaires') : await getSubtree('questionnaires');
  return rows.sort(byCreatedDesc);
}
async function listReports() {
  let rows;
  if (state.user.role === 'admin') rows = await getAll('submissions');
  else if (state.user.role === 'dept_head') rows = await getSubtree('submissions');
  else rows = await getWhere('submissions', 'userId', state.user.uid);
  return rows.sort((a, b) => millis(b.submittedAt) - millis(a.submittedAt));
}
async function listTasks() {
  let rows;
  if (state.user.role === 'admin') rows = await getAll('tasks');
  else if (state.user.role === 'dept_head') rows = await getSubtree('tasks');
  else rows = await getWhere('tasks', 'assignedTo', state.user.uid);
  return rows.sort(byCreatedDesc);
}
async function listNotifications() {
  return (await getWhere('notifications', 'userId', state.user.uid))
    .sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
}

/** Create a Firebase Auth user without disturbing the current admin session,
 *  by using a throwaway secondary app instance. Returns the new uid. */
async function createAuthUser(email, password) {
  const secondary = initializeApp(firebaseConfig, 'secondary-' + Date.now());
  const secAuth = getAuth(secondary);
  try {
    const cred = await createUserWithEmailAndPassword(secAuth, email, password);
    await signOut(secAuth);
    return cred.user.uid;
  } finally {
    await deleteApp(secondary);
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
function boot() {
  if (!CONFIG_READY) return renderConfigNotice();
  onAuthStateChanged(auth, async (fbUser) => {
    if (!fbUser) { state.user = null; return renderPublic(); }
    try {
      const profile = await getDoc(doc(db, 'users', fbUser.uid));
      if (!profile.exists()) return renderNoProfile(fbUser);
      state.user = { uid: fbUser.uid, email: fbUser.email, ...profile.data() };
      enterApp();
    } catch (err) {
      renderNoProfile(fbUser, friendlyError(err));
    }
  });
}

function renderConfigNotice() {
  root().innerHTML = '';
  root().append(centered(el('div', { class: 'card', style: 'max-width:560px' },
    el('h1', {}, 'Almost there'),
    el('p', { class: 'muted' }, 'Firebase is not configured yet. Edit '),
    el('pre', { style: 'background:#f1f5f9;padding:12px;border-radius:8px;overflow:auto' }, 'web/firebase-config.js'),
    el('p', { class: 'muted' }, 'and paste your project\'s web config, then reload.'))));
}
function renderNoProfile(fbUser, extra) {
  root().innerHTML = '';
  root().append(centered(el('div', { class: 'card', style: 'max-width:520px' },
    el('h1', {}, 'No access yet'),
    el('p', { class: 'muted' }, `You're signed in as ${fbUser.email}, but this account has no profile. An admin needs to add you before you can use the dashboard.`),
    extra ? el('p', { class: 'error' }, extra) : null,
    el('button', { class: 'btn', onclick: () => signOut(auth) }, 'Sign out'))));
}
function centered(cardNode) {
  return el('div', { style: 'min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px' }, cardNode);
}

/* ------------------------------------------------------------------ *
 * Public: report with a Unique ID / login
 * ------------------------------------------------------------------ */
function renderPublic() {
  root().innerHTML = '';
  const idInput = el('input', { class: 'code-entry', placeholder: 'YOUR ID', autocomplete: 'off' });
  const errBox = el('div', { class: 'error' });
  const container = el('div', {});
  const form = el('form', {}, idInput, el('button', { type: 'submit', class: 'btn primary' }, 'Open'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.textContent = '';
    container.innerHTML = '';
    const uniqueId = normId(idInput.value);
    if (!uniqueId) return;
    try {
      const snap = await getDoc(doc(db, 'codes', uniqueId));
      if (!snap.exists() || snap.data().active === false) throw new Error('That ID is not valid. Please check and try again.');
      openReporter(uniqueId, snap.data(), container);
    } catch (err) {
      errBox.textContent = friendlyError(err);
    }
  });

  const card = el('div', { class: 'card code-card' },
    el('h1', {}, 'Daily Reporting'),
    el('p', { class: 'muted' }, 'Enter your Unique ID to open your report.'),
    form, errBox, container,
    el('p', { class: 'switch' },
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); location.reload(); } }, '↻ Refresh'),
      el('span', {}, '   ·   '),
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); renderLogin(); } }, 'Staff / admin login →')));
  root().append(centered(card));
}

function renderLogin() {
  root().innerHTML = '';
  const email = el('input', { type: 'email', required: true });
  const password = el('input', { type: 'password', required: true });
  const errBox = el('div', { class: 'error' });
  const form = el('form', {},
    el('label', {}, 'Email', email),
    el('label', {}, 'Password', password),
    el('button', { type: 'submit', class: 'btn primary' }, 'Sign in'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.textContent = '';
    try { await signInWithEmailAndPassword(auth, email.value.trim(), password.value); }
    catch (err) { errBox.textContent = friendlyError(err); }
  });
  root().append(centered(el('div', { class: 'card login-card' },
    el('h1', {}, 'Sign in'), form, errBox,
    el('p', { class: 'switch' }, el('a', { href: '#', onclick: (e) => { e.preventDefault(); renderPublic(); } }, '← Report with your ID')))));
}

/** After a valid Unique ID, show the assigned questionnaire(s) and tasks. */
async function openReporter(uniqueId, codeData, container) {
  container.innerHTML = '';
  container.append(el('hr'), el('p', {}, el('strong', {}, `Hello, ${codeData.name || ''}`)));
  const qWrap = el('div', {});
  const tWrap = el('div', {});
  container.append(qWrap, tWrap);
  renderReporterQuestionnaires(uniqueId, codeData, qWrap);
  const taskCount = await renderReporterTasks(uniqueId, codeData, tWrap);
  if (!(codeData.questionnaires || []).length && !taskCount) {
    container.append(el('p', { class: 'muted' }, 'Nothing has been assigned to you yet — but you can still use your personal schedule below.'));
  }
  // personal schedule (always available to the code holder)
  const sWrap = el('div', {});
  container.append(sWrap, el('hr'), el('h3', {}, 'My schedule'));
  const sMount = el('div', {});
  container.append(sMount);
  renderScheduler(uniqueId, codeData.scheduled || [], sMount);
}

function renderReporterQuestionnaires(uniqueId, codeData, wrap) {
  const list = codeData.questionnaires || [];
  if (!list.length) return;
  wrap.append(el('h3', {}, 'Your report'));
  if (list.length === 1) { const d = el('div', {}); wrap.append(d); loadReportForm(uniqueId, codeData, list[0], d); return; }
  wrap.append(el('p', { class: 'muted' }, 'Choose a report to fill in:'));
  const forms = el('div', {});
  list.forEach((entry) => wrap.append(
    el('button', { class: 'btn', style: 'width:100%;justify-content:flex-start;margin-bottom:8px',
      onclick: () => loadReportForm(uniqueId, codeData, entry, forms) }, entry.title || 'Report')));
  wrap.append(forms);
}

/** Load the person's open tasks (by id from their code doc) and show update
 *  controls. Returns the number of open tasks shown. */
async function renderReporterTasks(uniqueId, codeData, wrap) {
  const ids = codeData.tasks || [];
  if (!ids.length) return 0;
  const tasks = [];
  for (const id of ids) {
    try {
      const s = await getDoc(doc(db, 'tasks', id));
      if (s.exists() && s.data().status !== 'closed') tasks.push({ id: s.id, ...s.data() });
    } catch { /* ignore */ }
  }
  if (!tasks.length) return 0;
  wrap.append(el('hr'), el('h3', {}, 'Your tasks'));
  tasks.forEach((task) => {
    const card = el('div', { class: 'q-builder-item' });
    const rebuild = () => {
      card.innerHTML = '';
      card.append(
        el('strong', {}, task.title),
        task.description ? el('div', { class: 'muted' }, task.description) : null,
        el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, taskMeta(task)),
        task.status === 'closed'
          ? el('span', { class: 'pill done' }, 'closed')
          : taskUpdateControls(task, { uniqueId }, rebuild));
    };
    rebuild();
    wrap.append(card);
  });
  return tasks.length;
}

async function loadReportForm(uniqueId, codeData, entry, container) {
  container.innerHTML = 'Loading…';
  try {
    const qn = await getDoc(doc(db, 'questionnaires', entry.questionnaireId));
    if (!qn.exists() || qn.data().active !== true) throw new Error('This questionnaire is no longer available.');
    renderReportForm(uniqueId, codeData, entry, { id: qn.id, ...qn.data() }, container);
  } catch (err) {
    container.innerHTML = '';
    container.append(el('p', { class: 'error' }, friendlyError(err)));
  }
}

function renderReportForm(uniqueId, codeData, entry, qn, container) {
  container.innerHTML = '';
  const form = el('form', {});
  form.append(el('hr'), el('p', {}, el('strong', {}, `Hello, ${codeData.name || ''}`)), el('h2', {}, qn.title),
    qn.description ? el('p', { class: 'muted' }, qn.description) : null);
  const questions = (qn.questions || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  const inputs = [];
  questions.forEach((q) => { const { node, get } = fieldFor(q); form.append(node); inputs.push({ q, get }); });
  const errBox = el('div', { class: 'error' });
  const btn = el('button', { type: 'submit', class: 'btn primary' }, 'Submit report');
  form.append(errBox, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.textContent = '';
    for (const { q, get } of inputs) {
      const v = get();
      const empty = v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');
      if (q.required && empty) { errBox.textContent = `"${q.text}" is required.`; return; }
    }
    btn.disabled = true;
    try {
      await addDoc(colRef('submissions'), {
        uniqueId,
        userId: codeData.userId,
        userName: codeData.name || '',
        assignmentId: entry.assignmentId,
        questionnaireId: entry.questionnaireId,
        questionnaireTitle: qn.title,
        departmentId: codeData.departmentId ?? null,
        deptPath: codeData.deptPath ?? null,
        answers: inputs.map(({ q, get }) => ({
          questionId: q.id, question: q.text,
          value: Array.isArray(get()) ? get().join(', ') : String(get()),
        })),
        submittedAt: serverTimestamp(),
      });
      container.innerHTML = '';
      container.append(el('div', { class: 'card', style: 'text-align:center;margin-top:16px' },
        el('h2', {}, '✓ Report submitted'),
        el('p', { class: 'muted' }, 'Thank you. Your report has been recorded.'),
        el('button', { class: 'btn', onclick: () => renderPublic() }, 'Done')));
    } catch (err) {
      errBox.textContent = friendlyError(err);
      btn.disabled = false;
    }
  });
  container.append(form);
}

function fieldFor(q) {
  const label = el('label', {}, q.text + (q.required ? ' *' : ''));
  let getter;
  const opts = q.options || [];
  if (q.type === 'textarea') { const i = el('textarea', {}); label.append(i); getter = () => i.value; }
  else if (q.type === 'number') { const i = el('input', { type: 'number', step: 'any' }); label.append(i); getter = () => i.value; }
  else if (q.type === 'date') { const i = el('input', { type: 'date' }); label.append(i); getter = () => i.value; }
  else if (q.type === 'select') {
    const s = el('select', {}, el('option', { value: '' }, '— choose —'), ...opts.map((o) => el('option', { value: o }, o)));
    label.append(s); getter = () => s.value;
  } else if (q.type === 'radio') {
    const w = el('div', { class: 'checkbox-list' });
    const name = 'r' + Math.random().toString(36).slice(2);
    opts.forEach((o) => w.append(el('label', {}, el('input', { type: 'radio', name, value: o }), o)));
    label.append(w); getter = () => (w.querySelector('input:checked') || {}).value || '';
  } else if (q.type === 'checkbox') {
    const w = el('div', { class: 'checkbox-list' });
    opts.forEach((o) => w.append(el('label', {}, el('input', { type: 'checkbox', value: o }), o)));
    label.append(w); getter = () => Array.from(w.querySelectorAll('input:checked')).map((c) => c.value);
  } else { const i = el('input', { type: 'text' }); label.append(i); getter = () => i.value; }
  return { node: label, get: getter };
}

/* ------------------------------------------------------------------ *
 * Authenticated app shell
 * ------------------------------------------------------------------ */
const PAGES = {
  admin: ['dashboard', 'departments', 'users', 'questionnaires', 'reports', 'tasks', 'pendency', 'schedule'],
  dept_head: ['dashboard', 'team', 'questionnaires', 'reports', 'tasks', 'pendency', 'schedule'],
  employee: ['tasks', 'reports', 'schedule'],
};
const LABELS = { dashboard: 'Dashboard', departments: 'Departments', users: 'Users', team: 'My Team', questionnaires: 'Questionnaires', reports: 'Reports', tasks: 'Tasks', pendency: 'Pendency', schedule: 'My Schedule' };

function enterApp() {
  root().innerHTML = '';
  const bellCount = el('span', { id: 'bell-count', class: 'badge hidden' }, '0');
  const bell = el('button', { class: 'bell', title: 'Notifications', onclick: toggleNotifications }, '🔔', bellCount);
  const nav = el('nav', { id: 'nav' });
  const shell = el('div', {},
    el('header', { class: 'topbar' },
      el('div', { class: 'brand' }, 'Daily Reporting'), nav,
      el('div', { class: 'topbar-right' }, bell,
        el('button', { class: 'btn ghost small', title: 'Refresh', onclick: () => location.reload() }, '↻'),
        el('span', { class: 'user-label' }, `${state.user.name} · ${state.user.role.replace('_', ' ')}`),
        el('button', { class: 'btn ghost small', onclick: () => signOut(auth) }, 'Logout'))),
    el('div', { id: 'notif-panel', class: 'notif-panel hidden' }), el('main', { id: 'page', class: 'page' }));
  root().append(shell);

  const pages = PAGES[state.user.role] || ['reports'];
  pages.forEach((p) => nav.append(el('button', { class: 'nav-item', 'data-page': p, onclick: () => navigate(p) },
    state.user.role === 'employee' && p === 'reports' ? 'My Reports'
      : state.user.role === 'employee' && p === 'tasks' ? 'My Tasks' : LABELS[p])));
  navigate(pages[0]);
  refreshNotifications();
  if (!state._notifTimer) state._notifTimer = setInterval(refreshNotifications, 30000);
}

const ROUTES = {
  dashboard: renderDashboard, departments: renderDepartments,
  users: () => renderUsers(false), team: () => renderUsers(true),
  questionnaires: renderQuestionnaires, reports: renderReports, tasks: renderTasks,
  pendency: renderPendency, schedule: renderSchedule,
};
function navigate(page) {
  state.page = page;
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  $('#notif-panel') && $('#notif-panel').classList.add('hidden');
  (ROUTES[page] || renderReports)();
}
function pageHead(title, actions = []) {
  return el('div', { class: 'page-head' }, el('h2', {}, title), el('div', { class: 'inline' }, ...actions));
}
async function withPage(fn) {
  const page = $('#page');
  page.innerHTML = 'Loading…';
  try { const node = await fn(); page.innerHTML = ''; page.append(...[].concat(node)); }
  catch (err) { page.innerHTML = ''; page.append(el('div', { class: 'empty' }, friendlyError(err))); }
}

/* ---- Notifications ---- */
async function refreshNotifications() {
  try {
    state.notifications = await listNotifications();
    const unread = state.notifications.filter((n) => !n.isRead).length;
    const badge = $('#bell-count');
    if (badge) { badge.textContent = unread; badge.classList.toggle('hidden', unread === 0); }
  } catch { /* ignore */ }
}
function toggleNotifications() {
  const panel = $('#notif-panel');
  if (!panel.classList.contains('hidden')) return panel.classList.add('hidden');
  panel.innerHTML = '';
  panel.append(el('div', { class: 'notif-head' }, el('strong', {}, 'Notifications'),
    el('button', { class: 'btn ghost small', onclick: markAllRead }, 'Mark all read')));
  if (!state.notifications.length) panel.append(el('div', { class: 'notif-item muted' }, 'No notifications yet.'));
  else state.notifications.forEach((n) => panel.append(el('div', { class: 'notif-item' + (n.isRead ? '' : ' unread') },
    el('div', {}, n.message), el('div', { class: 'time' }, fmtDate(n.createdAt)))));
  panel.classList.remove('hidden');
}
async function markAllRead() {
  const batch = writeBatch(db);
  state.notifications.filter((n) => !n.isRead).forEach((n) => batch.update(doc(db, 'notifications', n.id), { isRead: true }));
  await batch.commit();
  await refreshNotifications();
  toggleNotifications();
}

/* ---- Modal ---- */
function modal(title, contentNode, onSubmit, submitLabel = 'Save') {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const err = el('div', { class: 'error' });
  const form = el('form', { class: 'modal' }, el('h3', {}, title), contentNode, err,
    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'btn ghost', onclick: () => backdrop.remove() }, 'Cancel'),
      el('button', { type: 'submit', class: 'btn primary', style: 'width:auto' }, submitLabel)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    try { await onSubmit(); backdrop.remove(); } catch (ex) { err.textContent = friendlyError(ex); }
  });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.append(form);
  document.body.append(backdrop);
  return backdrop;
}
function infoModal(title, contentNode) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  backdrop.append(el('div', { class: 'modal' }, el('h3', {}, title), contentNode,
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn primary', style: 'width:auto', onclick: () => backdrop.remove() }, 'Close'))));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
  return backdrop;
}

/* ---- Dashboard ---- */
async function renderDashboard() {
  await withPage(async () => {
    const [reports, tasks] = await Promise.all([listReports(), listTasks()]);
    const openTasks = tasks.filter((t) => t.status !== 'closed').length;
    const pendingTotal = tasks.filter((t) => t.type === 'pendency' && t.status !== 'closed').reduce((s, t) => s + (t.pendency || 0), 0);
    return [pageHead(`Welcome, ${state.user.name}`),
      el('div', { class: 'grid' },
        tile('Reports', reports.length, 'in view'),
        tile('Open tasks', openTasks, `of ${tasks.length} total`),
        tile('Pending total', pendingTotal, 'across your scope'),
        tile('Unread alerts', state.notifications.filter((n) => !n.isRead).length, 'notifications')),
      el('h3', { style: 'margin-top:28px' }, 'Recent reports'), reportsTable(reports.slice(0, 8))];
  });
}
function tile(t, big, sub) { return el('div', { class: 'tile' }, el('h3', {}, t), el('div', { class: 'big' }, String(big)), el('div', { class: 'muted' }, sub)); }

/* ---- Departments ---- */
async function renderDepartments() {
  await withPage(async () => {
    const [departments, users] = await Promise.all([listDepartments(), listUsers()]);
    // order as a tree: sort by path so ancestors precede descendants
    const paths = computePaths(departments);
    const ordered = departments.slice().sort((a, b) =>
      (paths[a.id] || []).map((id) => deptName(departments, id)).join('/').localeCompare(
        (paths[b.id] || []).map((id) => deptName(departments, id)).join('/')));
    const head = pageHead('Departments', [el('button', { class: 'btn primary', style: 'width:auto', onclick: () => departmentModal(null, users, departments) }, '+ New department')]);
    if (!departments.length) return [head, el('div', { class: 'empty' }, 'No departments yet. The first one is your top-level branch.')];
    const tbody = el('tbody');
    ordered.forEach((d) => {
      const depth = (paths[d.id] || [d.id]).length - 1;
      const memberCount = users.filter((u) => u.departmentId === d.id).length;
      const headName = (users.find((u) => u.id === d.headUserId) || {}).name || '—';
      const label = (depth ? '—'.repeat(depth) + ' ' : '') + d.name;
      tbody.append(el('tr', {},
        el('td', {}, el('span', depth ? { class: 'muted' } : {}, label), depth ? null : el('span', { class: 'pill dept_head', style: 'margin-left:8px' }, 'branch')),
        el('td', {}, headName), el('td', {}, String(memberCount)),
        el('td', {}, el('div', { class: 'row-actions' },
          el('button', { class: 'btn ghost small', onclick: () => departmentModal(d, users, departments) }, 'Edit'),
          el('button', { class: 'btn danger small', onclick: () => delDepartment(d, users, departments) }, 'Delete')))));
    });
    return [head, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Department'), el('th', {}, 'Head'), el('th', {}, 'Members'), el('th', {}, ''))), tbody)];
  });
}

function departmentModal(dept, users, departments) {
  const name = el('input', { value: dept ? dept.name : '', required: true });
  // a department cannot be its own parent or a child of its own descendants
  const paths = computePaths(departments);
  const descendantIds = dept ? new Set(departments.filter((x) => (paths[x.id] || []).includes(dept.id)).map((x) => x.id)) : new Set();
  const parentOptions = departments.filter((x) => !descendantIds.has(x.id));
  const parent = el('select', {}, el('option', { value: '' }, '— none (top-level branch) —'),
    ...parentOptions.map((p) => el('option', { value: p.id, selected: dept && dept.parentId === p.id }, p.name)));
  const head = el('select', {}, el('option', { value: '' }, '— none —'),
    ...users.filter((u) => u.authUid).map((u) => el('option', { value: u.id, selected: dept && dept.headUserId === u.id }, `${u.name} (${u.email || u.uniqueId})`)));
  modal(dept ? 'Edit department' : 'New department',
    el('div', {},
      el('label', {}, 'Name', name),
      el('label', {}, 'Parent department', parent),
      el('label', {}, 'Department head (must have a login)', head)), async () => {
      const headId = head.value || null;
      const parentId = parent.value || null;
      const ref = dept ? doc(db, 'departments', dept.id) : doc(colRef('departments'));
      const id = dept ? dept.id : ref.id;
      // rebuild the whole tree's paths with this department's new parent
      const working = departments.filter((x) => x.id !== id).concat([{ id, parentId }]);
      const newPaths = computePaths(working);
      const batch = writeBatch(db);
      if (dept) batch.update(ref, { name: name.value.trim(), parentId, path: newPaths[id] });
      else batch.set(ref, { name: name.value.trim(), parentId, path: newPaths[id], headUserId: headId, createdAt: serverTimestamp() });
      // update descendants whose path changed
      departments.forEach((x) => {
        if (x.id === id) return;
        const np = newPaths[x.id] || [];
        if (JSON.stringify(np) !== JSON.stringify(x.path || [])) batch.update(doc(db, 'departments', x.id), { path: np });
      });
      if (headId) {
        const headUser = users.find((u) => u.id === headId);
        // promote an employee to dept_head, but never demote an existing admin
        const headRole = headUser && headUser.role === 'admin' ? 'admin' : 'dept_head';
        batch.update(doc(db, 'users', headId), { role: headRole, departmentId: id, deptPath: newPaths[id] });
      }
      await batch.commit();
      toast('Department saved'); renderDepartments();
    });
}

async function delDepartment(d, users, departments) {
  const children = departments.filter((x) => x.parentId === d.id);
  if (children.length) { toast('Move or delete its sub-departments first.', true); return; }
  if (!confirm(`Delete department "${d.name}"? Members will be unassigned.`)) return;
  const batch = writeBatch(db);
  users.filter((u) => u.departmentId === d.id).forEach((u) => batch.update(doc(db, 'users', u.id), { departmentId: null, deptPath: [] }));
  batch.delete(doc(db, 'departments', d.id));
  await batch.commit();
  toast('Department deleted'); renderDepartments();
}

/* ---- Users / Team ---- */
async function renderUsers(teamOnly) {
  await withPage(async () => {
    const [users, departments] = await Promise.all([listUsers(), listDepartments().catch(() => [])]);
    const deptName = (id) => (departments.find((d) => d.id === id) || {}).name || '—';
    const head = pageHead(teamOnly ? 'My Team' : 'Users', [el('button', { class: 'btn primary', style: 'width:auto', onclick: () => userModal(null, departments) }, '+ Add user')]);
    if (!users.length) return [head, el('div', { class: 'empty' }, 'No users yet. Add one to hand out a reporting ID.')];
    const tbody = el('tbody');
    users.forEach((u) => tbody.append(el('tr', {},
      el('td', {}, u.name),
      el('td', {}, el('span', { class: 'code-chip' }, u.uniqueId || '—'),
        u.uniqueId ? el('button', { class: 'btn ghost small', style: 'margin-left:6px', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(u.uniqueId); toast('Copied ' + u.uniqueId); } }, 'Copy') : null),
      el('td', {}, el('span', { class: 'pill ' + u.role }, u.role.replace('_', ' '))),
      el('td', {}, deptName(u.departmentId)),
      el('td', {}, u.authUid ? (u.email || 'yes') : '—'),
      el('td', {}, el('div', { class: 'row-actions' },
        el('button', { class: 'btn ghost small', onclick: () => userModal(u, departments) }, 'Edit'),
        u.id !== state.user.uid ? el('button', { class: 'btn danger small', onclick: () => delUser(u) }, 'Delete') : null)))));
    return [head, el('table', {}, el('thead', {}, el('tr', {},
      el('th', {}, 'Name'), el('th', {}, 'Unique ID'), el('th', {}, 'Role'), el('th', {}, 'Department'), el('th', {}, 'Login'), el('th', {}, ''))), tbody)];
  });
}

function userModal(user, departments) {
  const isAdmin = state.user.role === 'admin';
  const editing = !!user;
  const name = el('input', { value: user ? user.name : '', required: true });
  const uniqueId = el('input', { value: user ? user.uniqueId || '' : '', placeholder: 'e.g. EMP001', ...(editing ? { disabled: true } : { required: true }) });
  const role = el('select', {}, ...['employee', 'dept_head', 'admin'].map((r) => el('option', { value: r, selected: user && user.role === r }, r.replace('_', ' '))));
  const dept = el('select', {}, el('option', { value: '' }, '— none —'), ...departments.map((d) => el('option', { value: d.id, selected: user && user.departmentId === d.id }, d.name)));
  const email = el('input', { type: 'email', value: user ? user.email || '' : '', ...(editing ? { disabled: true } : {}) });
  const password = el('input', { type: 'password', placeholder: 'min 6 characters', ...(editing ? { disabled: true } : {}) });

  const loginSection = el('div', {},
    el('label', {}, 'Login email (optional)', email),
    el('label', {}, 'Login password (optional)', password),
    el('p', { class: 'muted', style: 'margin-top:-4px;font-size:13px' },
      editing ? 'Login details are managed in the Firebase console.' : 'Fill these only if this person needs to sign in. Managers (admin / dept head) require a login.'));

  const content = el('div', {},
    el('label', {}, 'Name', name),
    el('label', {}, 'Unique ID (used for reporting)', uniqueId),
    isAdmin ? el('label', {}, 'Role', role) : null,
    isAdmin ? el('label', {}, 'Department', dept) : null,
    loginSection);

  modal(editing ? 'Edit user' : 'Add user', content, async () => {
    if (editing) {
      const patch = { name: name.value.trim() };
      if (isAdmin) { patch.role = role.value; patch.departmentId = dept.value || null; patch.deptPath = deptPathOf(dept.value || null, departments); }
      await updateDoc(doc(db, 'users', user.id), patch);
      // keep the reporting-code doc's name/department in sync
      if (user.uniqueId) {
        const codePatch = { name: name.value.trim() };
        if (isAdmin) { codePatch.departmentId = dept.value || null; codePatch.deptPath = deptPathOf(dept.value || null, departments); }
        await updateDoc(doc(db, 'codes', user.uniqueId), codePatch).catch(() => {});
      }
      toast('User saved'); navigate(state.page); return;
    }

    // creating
    const uid = normId(uniqueId.value);
    if (!uid) throw new Error('A Unique ID is required.');
    const existing = await getDoc(doc(db, 'codes', uid));
    if (existing.exists()) throw new Error('That Unique ID is already in use.');

    const newRole = isAdmin ? role.value : 'employee';
    const newDept = isAdmin ? (dept.value || null) : state.user.departmentId;
    const wantsLogin = !!email.value.trim();
    if ((newRole === 'admin' || newRole === 'dept_head') && !wantsLogin)
      throw new Error('Admins and department heads need a login (email + password).');
    if (wantsLogin && password.value.length < 6) throw new Error('Login password must be at least 6 characters.');

    let docId, authUid = null;
    if (wantsLogin) { authUid = await createAuthUser(email.value.trim(), password.value); docId = authUid; }
    else { docId = doc(colRef('users')).id; }

    const newDeptPath = deptPathOf(newDept, departments);
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', docId), {
      name: name.value.trim(), uniqueId: uid, role: newRole, departmentId: newDept, deptPath: newDeptPath,
      authUid, email: wantsLogin ? email.value.trim() : null, createdAt: serverTimestamp(),
    });
    batch.set(doc(db, 'codes', uid), {
      userId: docId, name: name.value.trim(), departmentId: newDept, deptPath: newDeptPath, questionnaires: [], tasks: [], active: true,
    });
    await batch.commit();
    toast('User added'); navigate(state.page);
  });
}

async function delUser(u) {
  if (!confirm(`Remove "${u.name}"? Their reporting ID and assignments are removed.`)) return;
  const assigns = await getWhere('assignments', 'userId', u.id).catch(() => []);
  const batch = writeBatch(db);
  batch.delete(doc(db, 'users', u.id));
  if (u.uniqueId) batch.delete(doc(db, 'codes', u.uniqueId));
  assigns.forEach((a) => batch.delete(doc(db, 'assignments', a.id)));
  await batch.commit();
  toast('User removed');
  if (u.authUid) infoModal('One more step', el('div', {},
    el('p', {}, `${u.name}'s profile and reporting ID are removed.`),
    el('p', { class: 'muted' }, 'Their Firebase Authentication login still exists — remove it in the Firebase console → Authentication if you want it fully deleted.')));
  navigate(state.page);
}

/* ---- Questionnaires ---- */
const Q_TYPES = [['text', 'Short text'], ['textarea', 'Long text'], ['number', 'Number'], ['date', 'Date'], ['select', 'Dropdown'], ['radio', 'Single choice'], ['checkbox', 'Multiple choice']];
async function renderQuestionnaires() {
  await withPage(async () => {
    const list = await listQuestionnaires();
    const head = pageHead('Questionnaires', [el('button', { class: 'btn primary', style: 'width:auto', onclick: () => questionnaireModal(null) }, '+ New questionnaire')]);
    if (!list.length) return [head, el('div', { class: 'empty' }, 'No questionnaires yet. Create one to start collecting reports.')];
    const counts = await Promise.all(list.map((q) => getWhere('assignments', 'questionnaireId', q.id).then((a) => a.length).catch(() => 0)));
    const tbody = el('tbody');
    list.forEach((q, i) => tbody.append(el('tr', {},
      el('td', {}, q.title), el('td', {}, String((q.questions || []).length)), el('td', {}, String(counts[i])),
      el('td', {}, el('span', { class: 'pill ' + (q.active ? 'done' : 'pending') }, q.active ? 'active' : 'inactive')),
      el('td', {}, el('div', { class: 'row-actions' },
        el('button', { class: 'btn ghost small', onclick: () => manageAssignments(q) }, 'Assign'),
        el('button', { class: 'btn ghost small', onclick: () => questionnaireModal(q) }, 'Edit'),
        el('button', { class: 'btn danger small', onclick: () => delQuestionnaire(q) }, 'Delete'))))));
    return [head, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Title'), el('th', {}, 'Questions'), el('th', {}, 'Assigned'), el('th', {}, 'Status'), el('th', {}, ''))), tbody)];
  });
}
async function questionnaireModal(existing) {
  const isAdmin = state.user.role === 'admin';
  const departments = await listDepartments().catch(() => []);
  const title = el('input', { value: existing ? existing.title : '', required: true });
  const desc = el('textarea', {}, existing ? existing.description || '' : '');
  const deptSel = el('select', {}, el('option', { value: '' }, isAdmin ? '— none (admin-only) —' : '(your department)'),
    ...departments.map((d) => el('option', { value: d.id, selected: existing && existing.departmentId === d.id }, d.name)));
  const qWrap = el('div', {});
  const addQ = (q = {}, { atTop = false } = {}) => {
    const qid = q.id || 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const item = el('div', { class: 'q-builder-item' });
    const text = el('input', { placeholder: 'Question text', value: q.text || '' });
    const type = el('select', {}, ...Q_TYPES.map(([v, l]) => el('option', { value: v, selected: q.type === v }, l)));
    const required = el('input', { type: 'checkbox', ...(q.required ? { checked: true } : {}) });
    const options = el('input', { placeholder: 'Options (comma separated)', value: (q.options || []).join(', ') });
    const toggle = () => { options.style.display = ['select', 'radio', 'checkbox'].includes(type.value) ? '' : 'none'; };
    type.addEventListener('change', toggle);
    const moveUp = el('button', { type: 'button', class: 'btn ghost small', title: 'Move up', onclick: () => { if (item.previousElementSibling) qWrap.insertBefore(item, item.previousElementSibling); } }, '▲');
    const moveDown = el('button', { type: 'button', class: 'btn ghost small', title: 'Move down', onclick: () => { if (item.nextElementSibling) qWrap.insertBefore(item.nextElementSibling, item); } }, '▼');
    item.append(el('div', { class: 'q-row' }, text, moveUp, moveDown, el('button', { type: 'button', class: 'btn danger small', title: 'Remove', onclick: () => item.remove() }, '✕')),
      el('div', { class: 'q-row' }, type, el('label', { style: 'margin:0;font-weight:400' }, required, ' required')), options);
    toggle();
    item._get = () => ({ id: qid, text: text.value.trim(), type: type.value, required: required.checked, options: options.value.split(',').map((s) => s.trim()).filter(Boolean) });
    if (atTop && qWrap.firstChild) qWrap.insertBefore(item, qWrap.firstChild);
    else qWrap.append(item);
  };
  ((existing && existing.questions && existing.questions.length ? existing.questions : [{}])).forEach((q) => addQ(q));
  const content = el('div', {}, el('label', {}, 'Title', title), el('label', {}, 'Description', desc),
    isAdmin ? el('label', {}, 'Department', deptSel) : null,
    el('label', {}, 'Questions'), qWrap,
    el('div', { class: 'inline' },
      el('button', { type: 'button', class: 'btn', onclick: () => addQ({}, { atTop: true }) }, '+ Add at top'),
      el('button', { type: 'button', class: 'btn', onclick: () => addQ() }, '+ Add at end')));
  modal(existing ? 'Edit questionnaire' : 'New questionnaire', content, async () => {
    const questions = Array.from(qWrap.querySelectorAll('.q-builder-item')).map((n, i) => ({ ...n._get(), position: i })).filter((q) => q.text);
    if (!questions.length) throw new Error('Add at least one question');
    const departmentId = isAdmin ? (deptSel.value || null) : state.user.departmentId;
    const deptPath = deptPathOf(departmentId, departments);
    if (existing) await updateDoc(doc(db, 'questionnaires', existing.id), { title: title.value.trim(), description: desc.value.trim(), questions, departmentId, deptPath });
    else await addDoc(colRef('questionnaires'), {
      title: title.value.trim(), description: desc.value.trim(), questions, active: true,
      createdBy: state.user.uid, departmentId, deptPath, createdAt: serverTimestamp(),
    });
    toast('Questionnaire saved'); renderQuestionnaires();
  }, existing ? 'Save changes' : 'Create');
}
async function delQuestionnaire(q) {
  if (!confirm(`Delete "${q.title}"? Its assignments are removed (past reports are kept).`)) return;
  const [assigns, users] = await Promise.all([getWhere('assignments', 'questionnaireId', q.id), listUsers().catch(() => [])]);
  const uidById = Object.fromEntries(users.map((u) => [u.id, u.uniqueId]));
  const batch = writeBatch(db);
  assigns.forEach((a) => {
    batch.delete(doc(db, 'assignments', a.id));
    const code = uidById[a.userId];
    if (code) batch.update(doc(db, 'codes', code), { questionnaires: arrayRemove({ assignmentId: a.id, questionnaireId: q.id, title: q.title }) });
  });
  batch.delete(doc(db, 'questionnaires', q.id));
  await batch.commit();
  toast('Questionnaire deleted'); renderQuestionnaires();
}

async function manageAssignments(q) {
  const [assignments, users] = await Promise.all([getWhere('assignments', 'questionnaireId', q.id), listUsers()]);
  const userById = Object.fromEntries(users.map((u) => [u.id, u]));
  const listNode = el('div', {});
  const userSelect = el('select', {});
  infoModal(`Assign · ${q.title}`, el('div', {},
    el('p', { class: 'muted' }, `Assign "${q.title}" to people. Each reports by entering their own Unique ID.`),
    el('div', { class: 'inline' }, userSelect, el('button', { class: 'btn primary', style: 'width:auto', onclick: doAssign }, 'Assign')),
    el('hr'), listNode));

  let current = assignments;
  function refreshSelect() {
    const assigned = new Set(current.map((a) => a.userId));
    const available = users.filter((u) => !assigned.has(u.id));
    userSelect.innerHTML = '';
    userSelect.append(el('option', { value: '' }, available.length ? '— choose person —' : 'Everyone is assigned'),
      ...available.map((u) => el('option', { value: u.id }, `${u.name} (${u.uniqueId || 'no id'})`)));
  }
  function renderList() {
    listNode.innerHTML = '';
    if (!current.length) { listNode.append(el('p', { class: 'muted' }, 'No one assigned yet.')); return; }
    const tbody = el('tbody');
    current.forEach((a) => {
      const u = userById[a.userId] || {};
      tbody.append(el('tr', {}, el('td', {}, a.userName || u.name || '—'),
        el('td', {}, el('span', { class: 'code-chip' }, u.uniqueId || '—')),
        el('td', {}, el('button', { class: 'btn danger small', onclick: () => unassign(a) }, 'Remove'))));
    });
    listNode.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Person'), el('th', {}, 'Unique ID'), el('th', {}, ''))), tbody));
  }
  async function reload() { current = await getWhere('assignments', 'questionnaireId', q.id); refreshSelect(); renderList(); }
  async function doAssign() {
    if (!userSelect.value) return;
    const u = userById[userSelect.value];
    if (!u.uniqueId) { toast('That user has no Unique ID', true); return; }
    try {
      const assignRef = doc(colRef('assignments'));
      const entry = { assignmentId: assignRef.id, questionnaireId: q.id, title: q.title };
      const codeRef = doc(db, 'codes', u.uniqueId);
      const codeSnap = await getDoc(codeRef);
      const dp = u.deptPath || [];
      const batch = writeBatch(db);
      batch.set(assignRef, { questionnaireId: q.id, userId: u.id, userName: u.name, departmentId: u.departmentId ?? null, deptPath: dp, active: true, createdAt: serverTimestamp() });
      // Update the code doc, or create it if it somehow doesn't exist yet.
      if (codeSnap.exists()) batch.update(codeRef, { questionnaires: arrayUnion(entry) });
      else batch.set(codeRef, { userId: u.id, name: u.name, departmentId: u.departmentId ?? null, deptPath: dp, questionnaires: [entry], tasks: [], active: true });
      if (u.authUid) batch.set(doc(colRef('notifications')), { userId: u.id, message: `New questionnaire assigned: "${q.title}"`, type: 'questionnaire', relatedId: assignRef.id, isRead: false, createdAt: serverTimestamp() });
      await batch.commit();
      toast('Assigned'); reload();
    } catch (e) { toast(friendlyError(e), true); }
  }
  async function unassign(a) {
    const u = userById[a.userId] || {};
    if (!confirm(`Remove ${a.userName || u.name}'s assignment?`)) return;
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, 'assignments', a.id));
      if (u.uniqueId) batch.update(doc(db, 'codes', u.uniqueId), { questionnaires: arrayRemove({ assignmentId: a.id, questionnaireId: q.id, title: q.title }) });
      await batch.commit(); toast('Removed'); reload();
    } catch (e) { toast(friendlyError(e), true); }
  }
  refreshSelect(); renderList();
}

/* ---- Reports ---- */
async function renderReports() {
  await withPage(async () => {
    const reports = await listReports();
    const isEmployee = state.user.role === 'employee';
    const actions = isEmployee ? [] : [el('button', { class: 'btn', style: 'width:auto', onclick: () => exportCsv(reports) }, '⭳ Export CSV')];
    const head = pageHead(isEmployee ? 'My Reports' : 'Reports', actions);
    if (!reports.length) return [head, el('div', { class: 'empty' }, isEmployee ? 'You have not submitted any reports yet.' : 'No reports submitted yet.')];
    return [head, reportsTable(reports)];
  });
}
function reportsTable(reports) {
  if (!reports.length) return el('div', { class: 'empty' }, 'No reports yet.');
  const tbody = el('tbody');
  reports.forEach((r) => tbody.append(el('tr', {}, el('td', {}, fmtDate(r.submittedAt)), el('td', {}, r.userName),
    el('td', {}, r.questionnaireTitle), el('td', {}, String((r.answers || []).length)),
    el('td', {}, el('button', { class: 'btn ghost small', onclick: () => viewReport(r) }, 'View')))));
  return el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Submitted'), el('th', {}, 'Employee'), el('th', {}, 'Questionnaire'), el('th', {}, 'Answers'), el('th', {}, ''))), tbody);
}
function viewReport(r) {
  infoModal(r.questionnaireTitle, el('div', {}, el('p', { class: 'muted' }, `${r.userName} · ${fmtDate(r.submittedAt)}`),
    ...(r.answers || []).map((a) => el('div', { class: 'report-answer' }, el('div', { class: 'q' }, a.question), el('div', { class: 'a' }, a.value || '—')))));
}
function exportCsv(reports) {
  const header = ['submitted_at', 'employee', 'questionnaire', 'question', 'answer'];
  const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [header.join(',')];
  reports.forEach((r) => (r.answers || []).forEach((a) => lines.push([fmtDate(r.submittedAt), r.userName, r.questionnaireTitle, a.question, a.value].map(cell).join(','))));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: 'daily-reports.csv' });
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

/* ---- Personal schedule (user-level planner, private to the user) ---- */
function todayStr() { return new Date().toISOString().slice(0, 10); }
async function saveScheduler(uniqueId, items) {
  await updateDoc(doc(db, 'codes', uniqueId), { scheduled: items });
}
/** Render the personal scheduler into `mount`. Items live in codes/{uniqueId}. */
function renderScheduler(uniqueId, items, mount) {
  let list = (items || []).slice();
  const byDateTime = (a, b) => (String(a.date || '') + (a.time || '')).localeCompare(String(b.date || '') + (b.time || ''));
  const persist = async (next, msg) => {
    const prev = list;
    list = next;
    try { await saveScheduler(uniqueId, list); if (msg) toast(msg); rerender(); }
    catch (e) { list = prev; toast(friendlyError(e), true); }
  };
  function itemRow(item) {
    const cb = el('input', { type: 'checkbox', ...(item.done ? { checked: true } : {}),
      onchange: () => persist(list.map((x) => x.id === item.id ? { ...x, done: cb.checked } : x)) });
    const meta = [item.date, item.time, item.priority && item.priority !== 'normal' ? item.priority : null]
      .filter(Boolean).join(' • ') + (item.note ? ' — ' + item.note : '');
    return el('div', { class: 'q-builder-item', style: 'display:flex;align-items:center;gap:10px' + (item.done ? ';opacity:.55' : '') },
      cb,
      el('div', { style: 'flex:1' },
        el('strong', item.done ? { style: 'text-decoration:line-through' } : {}, item.title),
        meta ? el('div', { class: 'muted', style: 'font-size:12px' }, meta) : null),
      el('button', { class: 'btn danger small', title: 'Delete', onclick: () => persist(list.filter((x) => x.id !== item.id), 'Removed') }, '✕'));
  }
  function rerender() {
    mount.innerHTML = '';
    // add form
    const title = el('input', { placeholder: 'Task title' });
    const date = el('input', { type: 'date', value: todayStr() });
    const time = el('input', { type: 'time' });
    const prio = el('select', {}, el('option', { value: 'normal' }, 'Normal'), el('option', { value: 'high' }, 'High'), el('option', { value: 'low' }, 'Low'));
    const note = el('input', { placeholder: 'Note (optional)' });
    const addBtn = el('button', { class: 'btn primary', style: 'width:auto', onclick: () => {
      if (!title.value.trim()) { toast('Enter a task title', true); return; }
      persist(list.concat([{ id: 's' + Date.now() + Math.random().toString(36).slice(2, 6), title: title.value.trim(), date: date.value || todayStr(), time: time.value || '', priority: prio.value, note: note.value.trim(), done: false, createdAt: new Date().toISOString() }]), 'Added');
    } }, '+ Add');
    mount.append(el('div', { class: 'q-builder-item' },
      title,
      el('div', { class: 'inline', style: 'margin-top:8px' },
        el('label', { style: 'flex:1;margin:0' }, 'Date', date),
        el('label', { style: 'flex:1;margin:0' }, 'Time', time),
        el('label', { style: 'flex:1;margin:0' }, 'Priority', prio)),
      el('div', { class: 'inline', style: 'margin-top:8px' }, el('div', { style: 'flex:1' }, note), addBtn)));
    const today = todayStr();
    const open = list.filter((i) => !i.done);
    const done = list.filter((i) => i.done);
    const overdue = open.filter((i) => i.date && i.date < today).sort(byDateTime);
    const todays = open.filter((i) => i.date === today).sort(byDateTime);
    const upcoming = open.filter((i) => !i.date || i.date > today).sort(byDateTime);
    const group = (label, arr) => { if (!arr.length) return; mount.append(el('h4', { style: 'margin:16px 0 6px' }, label)); arr.forEach((it) => mount.append(itemRow(it))); };
    group('⚠ Overdue', overdue);
    group('Today', todays);
    group('Upcoming', upcoming);
    if (done.length) { mount.append(el('h4', { class: 'muted', style: 'margin:16px 0 6px' }, 'Done')); done.sort(byDateTime).forEach((it) => mount.append(itemRow(it))); }
    if (!list.length) mount.append(el('p', { class: 'muted' }, 'No scheduled tasks yet. Add one above.'));
  }
  rerender();
}

async function renderSchedule() {
  await withPage(async () => {
    const uid = state.user.uniqueId;
    const head = pageHead('My Schedule');
    if (!uid) return [head, el('div', { class: 'empty' }, 'Your account has no Unique ID, so there is no personal schedule. An admin can set one on your user.')];
    const snap = await getDoc(doc(db, 'codes', uid));
    const items = snap.exists() ? (snap.data().scheduled || []) : [];
    const mount = el('div', {});
    renderScheduler(uid, items, mount);
    return [head, mount];
  });
}

/* ---- Cumulative pendency (roll-up across the subtree) ---- */
async function renderPendency() {
  await withPage(async () => {
    const [tasks, departments] = await Promise.all([listTasks(), listDepartments().catch(() => [])]);
    const pend = tasks.filter((t) => t.type === 'pendency' && t.status !== 'closed');
    const head = pageHead('Pendency (cumulative)');
    const grand = pend.reduce((s, t) => s + (t.pendency || 0), 0);
    const totalTile = el('div', { class: 'tile', style: 'margin-bottom:14px' }, el('h3', {}, 'Total pending (your scope)'), el('div', { class: 'big' }, String(grand)), el('div', { class: 'muted' }, `${pend.length} open quantity task(s)`));
    if (!pend.length) return [head, totalTile, el('div', { class: 'empty' }, 'No open quantity/pendency tasks.')];

    const paths = computePaths(departments);
    let scopeDepts = departments;
    if (state.user.role === 'dept_head') {
      const my = state.user.departmentId;
      scopeDepts = departments.filter((d) => (paths[d.id] || []).includes(my));
    }
    const ordered = scopeDepts.slice().sort((a, b) =>
      (paths[a.id] || []).map((id) => deptName(departments, id)).join('/').localeCompare(
        (paths[b.id] || []).map((id) => deptName(departments, id)).join('/')));
    const direct = (id) => pend.filter((t) => t.departmentId === id).reduce((s, t) => s + (t.pendency || 0), 0);
    const cumulative = (id) => pend.filter((t) => (t.deptPath || []).includes(id)).reduce((s, t) => s + (t.pendency || 0), 0);
    const openCount = (id) => pend.filter((t) => (t.deptPath || []).includes(id)).length;

    const tbody = el('tbody');
    ordered.forEach((d) => {
      const depth = (paths[d.id] || [d.id]).length - 1;
      tbody.append(el('tr', {},
        el('td', {}, el('span', depth ? { class: 'muted' } : {}, (depth ? '—'.repeat(depth) + ' ' : '') + d.name)),
        el('td', {}, String(direct(d.id))),
        el('td', {}, el('strong', {}, String(cumulative(d.id)))),
        el('td', {}, String(openCount(d.id)))));
    });
    const noDept = pend.filter((t) => !t.departmentId);
    if (noDept.length) tbody.append(el('tr', {}, el('td', {}, '(no department)'),
      el('td', {}, String(noDept.reduce((s, t) => s + (t.pendency || 0), 0))), el('td', {}, '—'), el('td', {}, String(noDept.length))));

    return [head, totalTile,
      el('p', { class: 'muted', style: 'margin:0 0 12px' }, 'Direct = quantity tasks in that department. Cumulative = that department plus every sub-department beneath it.'),
      el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Department'), el('th', {}, 'Direct'), el('th', {}, 'Cumulative'), el('th', {}, 'Open tasks'))), tbody)];
  });
}

/* ---- Tasks ---- */
function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

function taskMeta(t) {
  const parts = [t.type === 'pendency' ? 'quantity' : 'one-time'];
  if (t.dueDate) parts.push('due ' + t.dueDate);
  else if (t.horizonDays) parts.push(t.horizonDays + '-day');
  if (t.type === 'onetime' && t.oneTimeStatus === 'completed' && t.completedDate) parts.push('completed ' + t.completedDate);
  if (t.type === 'onetime' && t.oneTimeStatus !== 'completed' && t.pendingReason) parts.push('reason: ' + t.pendingReason);
  return parts.join(' • ');
}

/** Build the inline update controls for a task. Shared by the reporting flow
 *  (unauthenticated, ctx.uniqueId = entered code) and the dashboard. */
function taskUpdateControls(task, ctx, onDone) {
  const wrap = el('div', {});
  const err = el('div', { class: 'error' });
  if (task.type === 'pendency') {
    const completed = el('input', { type: 'number', min: '0', step: '1', value: '0' });
    const added = el('input', { type: 'number', min: '0', step: '1', value: '0' });
    const btn = el('button', { class: 'btn primary', style: 'width:auto' }, 'Update');
    btn.addEventListener('click', async () => {
      err.textContent = '';
      const c = Math.max(0, parseInt(completed.value || '0', 10) || 0);
      const a = Math.max(0, parseInt(added.value || '0', 10) || 0);
      btn.disabled = true;
      try { await commitTaskUpdate(task, ctx, { completed: c, added: a }); onDone && onDone(); }
      catch (e) { err.textContent = friendlyError(e); btn.disabled = false; }
    });
    wrap.append(
      el('p', {}, 'Currently pending: ', el('strong', {}, String(task.pendency ?? 0))),
      el('div', { class: 'inline' },
        el('label', { style: 'flex:1' }, 'Completed today', completed),
        el('label', { style: 'flex:1' }, 'Newly added', added)),
      btn, err);
  } else {
    const grp = 'ot' + task.id;
    const doneR = el('input', { type: 'radio', name: grp, value: 'completed' });
    const pendR = el('input', { type: 'radio', name: grp, value: 'pending', checked: true });
    const reason = el('textarea', { placeholder: 'Reason for still pending' });
    const btn = el('button', { class: 'btn primary', style: 'width:auto' }, 'Update');
    btn.addEventListener('click', async () => {
      err.textContent = '';
      const completed = doneR.checked;
      if (!completed && !reason.value.trim()) { err.textContent = 'Please give a reason for pending.'; return; }
      btn.disabled = true;
      try { await commitTaskUpdate(task, ctx, { completed, reason: reason.value.trim() }); onDone && onDone(); }
      catch (e) { err.textContent = friendlyError(e); btn.disabled = false; }
    });
    wrap.append(
      el('div', { class: 'checkbox-list' }, el('label', {}, doneR, ' Completed'), el('label', {}, pendR, ' Still pending')),
      el('label', {}, 'If pending, reason', reason), btn, err);
  }
  return wrap;
}

async function commitTaskUpdate(task, ctx, data) {
  const today = new Date().toISOString().slice(0, 10);
  const uniqueId = (ctx && ctx.uniqueId) || task.assignedUniqueId;
  const batch = writeBatch(db);
  const taskRef = doc(db, 'tasks', task.id);
  const upRef = doc(colRef('taskUpdates'));
  const base = {
    taskId: task.id, userId: task.assignedTo, uniqueId, departmentId: task.departmentId ?? null,
    deptPath: task.deptPath ?? [], type: task.type, date: today, createdAt: serverTimestamp(),
  };
  if (task.type === 'pendency') {
    const before = task.pendency ?? 0;
    const after = before - data.completed + data.added;
    batch.update(taskRef, { pendency: after, status: after <= 0 ? 'closed' : 'open', updatedAt: serverTimestamp() });
    batch.set(upRef, { ...base, completed: data.completed, added: data.added, before, after });
    task.pendency = after; task.status = after <= 0 ? 'closed' : 'open';
  } else if (data.completed) {
    batch.update(taskRef, { oneTimeStatus: 'completed', completedDate: today, status: 'closed', updatedAt: serverTimestamp() });
    batch.set(upRef, { ...base, action: 'completed', completedDate: today });
    task.oneTimeStatus = 'completed'; task.status = 'closed';
  } else {
    batch.update(taskRef, { pendingReason: data.reason, updatedAt: serverTimestamp() });
    batch.set(upRef, { ...base, action: 'pending', reason: data.reason });
    task.pendingReason = data.reason;
  }
  await batch.commit();
  toast('Task updated');
}

async function renderTasks() {
  await withPage(async () => {
    const canAssign = state.user.role === 'admin' || state.user.role === 'dept_head';
    const [tasks, users] = await Promise.all([listTasks(), canAssign ? listUsers() : Promise.resolve([])]);
    const isEmployee = state.user.role === 'employee';
    const actions = canAssign ? [el('button', { class: 'btn primary', style: 'width:auto', onclick: () => taskModal(users) }, '+ Assign task')] : [];
    const head = pageHead(isEmployee ? 'My Tasks' : 'Tasks', actions);
    if (!tasks.length) return [head, el('div', { class: 'empty' }, 'No tasks.')];
    const tbody = el('tbody');
    tasks.forEach((t) => {
      const progress = t.type === 'pendency'
        ? el('span', {}, `pending ${t.pendency ?? 0}` + (t.initialPendency != null ? ` / start ${t.initialPendency}` : ''))
        : el('span', { class: 'pill ' + (t.oneTimeStatus === 'completed' ? 'done' : 'pending') }, t.oneTimeStatus || 'pending');
      tbody.append(el('tr', {},
        el('td', {}, el('div', {}, el('strong', {}, t.title), t.description ? el('div', { class: 'muted' }, t.description) : null,
          el('div', { class: 'muted', style: 'font-size:12px' }, taskMeta(t)))),
        el('td', {}, t.assignedToName || ''),
        el('td', {}, t.type === 'pendency' ? 'quantity' : 'one-time'),
        el('td', {}, progress),
        el('td', {}, el('span', { class: 'pill ' + (t.status === 'closed' ? 'done' : 'pending') }, t.status || 'open')),
        el('td', {}, el('div', { class: 'row-actions' },
          t.status !== 'closed' ? el('button', { class: 'btn ghost small', onclick: () => openTaskUpdate(t) }, 'Update') : null,
          el('button', { class: 'btn ghost small', onclick: () => taskHistory(t) }, 'History'),
          canAssign ? el('button', { class: 'btn danger small', onclick: () => delTask(t) }, 'Delete') : null))));
    });
    return [head, el('table', {}, el('thead', {}, el('tr', {},
      el('th', {}, 'Task'), el('th', {}, 'Assignee'), el('th', {}, 'Type'), el('th', {}, 'Progress'), el('th', {}, 'Status'), el('th', {}, ''))), tbody)];
  });
}

function openTaskUpdate(t) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: 'modal' }, el('h3', {}, 'Update · ' + t.title),
    el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, taskMeta(t)),
    taskUpdateControls(t, { uniqueId: t.assignedUniqueId }, () => { backdrop.remove(); renderTasks(); }),
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn ghost', onclick: () => backdrop.remove() }, 'Close')));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.append(box); document.body.append(backdrop);
}

async function taskHistory(t) {
  let ups = [];
  try { ups = (await getWhere('taskUpdates', 'taskId', t.id)).sort((a, b) => millis(a.createdAt) - millis(b.createdAt)); } catch { /* ignore */ }
  const body = el('div', {});
  if (!ups.length) body.append(el('p', { class: 'muted' }, 'No updates yet.'));
  else ups.forEach((u) => {
    const when = u.date || fmtDate(u.createdAt);
    const line = u.type === 'pendency'
      ? `${when}: completed ${u.completed}, added ${u.added} → pending ${u.after}`
      : `${when}: ${u.action}${u.reason ? ' — ' + u.reason : ''}${u.completedDate ? ' (' + u.completedDate + ')' : ''}`;
    body.append(el('div', { class: 'report-answer' }, el('div', { class: 'a' }, line)));
  });
  infoModal('History · ' + t.title, body);
}

function taskModal(users) {
  const title = el('input', { required: true });
  const desc = el('textarea', {});
  const assignable = users.filter((u) => u.id !== state.user.uid && u.uniqueId);
  const assignee = el('select', { required: true }, el('option', { value: '' }, assignable.length ? '— choose —' : 'Add a user first'),
    ...assignable.map((u) => el('option', { value: u.id }, `${u.name} (${u.uniqueId})`)));
  const type = el('select', {}, el('option', { value: 'onetime' }, 'One-time'), el('option', { value: 'pendency' }, 'Quantity / pendency'));
  const horizon = el('input', { type: 'number', min: '0', step: '1', placeholder: 'e.g. 15' });
  const pend = el('input', { type: 'number', min: '1', step: '1', placeholder: 'e.g. 100' });
  const pendLabel = el('label', {}, 'Starting pending count', pend);
  pendLabel.style.display = 'none';
  type.addEventListener('change', () => { pendLabel.style.display = type.value === 'pendency' ? '' : 'none'; });
  modal('Assign task', el('div', {},
    el('label', {}, 'Title', title), el('label', {}, 'Description', desc),
    el('label', {}, 'Assign to', assignee),
    el('label', {}, 'Type', type),
    el('label', {}, 'Horizon in days (optional)', horizon),
    pendLabel,
    el('p', { class: 'muted', style: 'font-size:13px' }, 'The person updates this task by entering their Unique ID to report, or from their dashboard if they have a login.')), async () => {
    if (!assignee.value) throw new Error('Choose an assignee');
    const u = users.find((x) => x.id === assignee.value);
    if (!u.uniqueId) throw new Error('That user has no Unique ID.');
    const t = type.value;
    const horizonDays = horizon.value ? parseInt(horizon.value, 10) : null;
    const dueDate = horizonDays ? addDays(horizonDays) : null;
    let pendency = null;
    if (t === 'pendency') { pendency = parseInt(pend.value || '0', 10); if (!(pendency > 0)) throw new Error('Enter a starting pending count greater than 0.'); }
    const taskRef = doc(colRef('tasks'));
    const batch = writeBatch(db);
    batch.set(taskRef, {
      title: title.value.trim(), description: desc.value.trim(),
      assignedTo: u.id, assignedToName: u.name, assignedUniqueId: u.uniqueId, assignedBy: state.user.uid,
      departmentId: u.departmentId ?? null, deptPath: u.deptPath || [], type: t, horizonDays, dueDate, status: 'open',
      oneTimeStatus: t === 'onetime' ? 'pending' : null, pendingReason: null, completedDate: null,
      pendency: t === 'pendency' ? pendency : null, initialPendency: t === 'pendency' ? pendency : null,
      createdAt: serverTimestamp(),
    });
    batch.update(doc(db, 'codes', u.uniqueId), { tasks: arrayUnion(taskRef.id) });
    if (u.authUid) batch.set(doc(colRef('notifications')), { userId: u.id, message: `New task assigned: "${title.value.trim()}"`, type: 'task', relatedId: taskRef.id, isRead: false, createdAt: serverTimestamp() });
    await batch.commit(); toast('Task assigned'); renderTasks();
  }, 'Assign');
}

async function delTask(t) {
  if (!confirm(`Delete task "${t.title}"?`)) return;
  const batch = writeBatch(db);
  batch.delete(doc(db, 'tasks', t.id));
  if (t.assignedUniqueId) batch.update(doc(db, 'codes', t.assignedUniqueId), { tasks: arrayRemove(t.id) });
  await batch.commit();
  toast('Task deleted'); renderTasks();
}

/* ------------------------------------------------------------------ */
boot();
