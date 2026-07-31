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
  const oWrap = el('div', {});
  const qWrap = el('div', {});
  const tWrap = el('div', {});
  container.append(oWrap, qWrap, tWrap);
  renderReporterObservations(uniqueId, codeData, oWrap);
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

/** Show manager observations to the reporter and let them reply. Stored on the
 *  code doc so the (anonymous) reporter can read and append a reply. */
function renderReporterObservations(uniqueId, codeData, wrap) {
  let obs = (codeData.observations || []).slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  if (!obs.length) return;
  const box = el('div', {});
  wrap.append(box);
  const rebuild = () => {
    box.innerHTML = '';
    box.append(el('h3', {}, '📣 Feedback from your manager'));
    obs.forEach((o) => {
      const card = el('div', { class: 'card', style: 'background:#fffbeb;border:1px solid #fde68a;padding:12px;margin-bottom:10px' });
      card.append(
        el('div', { style: 'font-weight:600' }, o.message),
        el('div', { class: 'muted', style: 'font-size:12px;margin:4px 0' }, `${o.fromName || 'Manager'}${o.at ? ' · ' + String(o.at).slice(0, 10) : ''}`));
      if (o.reply) {
        card.append(el('div', { style: 'margin-top:6px' }, el('span', { class: 'muted' }, 'Your reply: '), o.reply));
      } else {
        const ta = el('textarea', { placeholder: 'Reply to this observation…' });
        const btn = el('button', { class: 'btn small', style: 'margin-top:6px', onclick: async () => {
          const text = ta.value.trim(); if (!text) return;
          btn.disabled = true;
          try {
            obs = obs.map((x) => x.id === o.id ? { ...x, reply: text, replyAt: new Date().toISOString() } : x);
            await updateDoc(doc(db, 'codes', uniqueId), { observations: obs });
            codeData.observations = obs; toast('Reply sent'); rebuild();
          } catch (e) { btn.disabled = false; toast(friendlyError(e), true); }
        } }, 'Send reply');
        card.append(ta, btn);
      }
      box.append(card);
    });
  };
  rebuild();
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
          : task.status === 'awaiting_approval'
            ? el('span', { class: 'pill pending' }, '✓ Completed — awaiting approval')
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
  form.append(el('h2', {}, qn.title),
    qn.description ? el('p', { class: 'muted' }, qn.description) : null);

  // Mandatory reporting date — the date the report is FOR (defaults to today,
  // never in the future). One report per person + questionnaire + date.
  const dateI = el('input', { type: 'date', required: true, value: localYmd(), max: localYmd() });
  form.append(el('label', {}, 'Date of reporting *', dateI));
  const banner = el('div', {});
  form.append(banner);

  const questions = (qn.questions || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  const inputs = [];
  const fieldsWrap = el('div', {});
  questions.forEach((q) => { const f = fieldFor(q); fieldsWrap.append(f.node); inputs.push({ q, get: f.get, set: f.set }); });
  form.append(fieldsWrap);

  const errBox = el('div', { class: 'error' });
  const btn = el('button', { type: 'submit', class: 'btn primary' }, 'Submit report');
  form.append(errBox, btn);

  const subId = (date) => `${entry.assignmentId}__${date}`;
  let existing = null, editing = false;
  const applyAnswers = (sub) => { const m = {}; (sub.answers || []).forEach((a) => { m[a.questionId] = a.value; }); inputs.forEach((f) => f.set(m[f.q.id] != null ? m[f.q.id] : '')); };
  const clearAnswers = () => inputs.forEach((f) => f.set(''));
  const lockFields = (dis) => fieldsWrap.querySelectorAll('input,select,textarea,button').forEach((n) => { n.disabled = dis; });

  async function checkDate() {
    banner.innerHTML = ''; errBox.textContent = ''; existing = null; editing = false;
    const date = dateI.value;
    lockFields(false); btn.style.display = ''; btn.textContent = 'Submit report';
    if (!date) { btn.style.display = 'none'; return; }
    let snap;
    try { snap = await getDoc(doc(db, 'submissions', subId(date))); }
    catch { return; } // if the lookup fails, fall back to a normal submit
    if (!snap.exists()) { clearAnswers(); return; }
    // Already reported for this date → offer Modify or Delete.
    existing = { id: snap.id, ...snap.data() };
    lockFields(true); btn.style.display = 'none';
    const note = el('div', { class: 'muted', style: 'margin-bottom:8px' }, `You already reported for ${date}. You can modify or delete it.`);
    const modBtn = el('button', { type: 'button', class: 'btn', onclick: () => {
      editing = true; lockFields(false); applyAnswers(existing);
      btn.style.display = ''; btn.textContent = 'Save changes';
      note.textContent = `Editing your report for ${date} — change the answers and Save.`;
    } }, 'Modify');
    const delBtn = el('button', { type: 'button', class: 'btn danger', onclick: async () => {
      if (!confirm(`Delete your report for ${date}?`)) return;
      try { await deleteDoc(doc(db, 'submissions', existing.id)); toast('Report deleted'); checkDate(); }
      catch (e) { toast(friendlyError(e), true); }
    } }, 'Delete');
    banner.append(el('div', { class: 'card', style: 'background:#f0f6ff;padding:12px;margin:10px 0' },
      note, el('div', { class: 'inline' }, modBtn, delBtn)));
  }
  dateI.addEventListener('change', checkDate);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.textContent = '';
    const date = dateI.value;
    if (!date) { errBox.textContent = 'Please choose the date of reporting.'; return; }
    for (const { q, get } of inputs) {
      const v = get();
      const empty = v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');
      if (q.required && empty) { errBox.textContent = `"${q.text}" is required.`; return; }
    }
    btn.disabled = true;
    const answers = inputs.map(({ q, get }) => ({
      questionId: q.id, question: q.text,
      value: Array.isArray(get()) ? get().join(', ') : String(get()),
    }));
    try {
      await setDoc(doc(db, 'submissions', subId(date)), {
        uniqueId,
        userId: codeData.userId,
        userName: codeData.name || '',
        assignmentId: entry.assignmentId,
        questionnaireId: entry.questionnaireId,
        questionnaireTitle: qn.title,
        departmentId: codeData.departmentId ?? null,
        deptPath: codeData.deptPath ?? null,
        reportDate: date,
        answers,
        submittedAt: serverTimestamp(),
      });
      container.innerHTML = '';
      container.append(el('div', { class: 'card', style: 'text-align:center;margin-top:16px' },
        el('h2', {}, editing ? '✓ Report updated' : '✓ Report submitted'),
        el('p', { class: 'muted' }, `Recorded for ${date}.`),
        performanceCard(qn, codeData, answers),
        el('button', { class: 'btn', style: 'margin-top:14px', onclick: () => renderPublic() }, 'Done')));
    } catch (err) {
      errBox.textContent = friendlyError(err);
      btn.disabled = false;
    }
  });
  container.append(form);
  checkDate();
}

function fieldFor(q) {
  const label = el('label', {}, q.text + (q.required ? ' *' : ''));
  let getter, setter = () => {};
  const opts = q.options || [];
  if (q.type === 'textarea') { const i = el('textarea', {}); label.append(i); getter = () => i.value; setter = (v) => { i.value = v || ''; }; }
  else if (q.type === 'number') { const i = el('input', { type: 'number', step: 'any' }); label.append(i); getter = () => i.value; setter = (v) => { i.value = v || ''; }; }
  else if (q.type === 'date') { const i = el('input', { type: 'date' }); label.append(i); getter = () => i.value; setter = (v) => { i.value = v || ''; }; }
  else if (q.type === 'select') {
    const s = el('select', {}, el('option', { value: '' }, '— choose —'), ...opts.map((o) => el('option', { value: o }, o)));
    label.append(s); getter = () => s.value; setter = (v) => { s.value = v || ''; };
  } else if (q.type === 'radio') {
    const w = el('div', { class: 'checkbox-list' });
    const name = 'r' + Math.random().toString(36).slice(2);
    opts.forEach((o) => w.append(el('label', {}, el('input', { type: 'radio', name, value: o }), o)));
    label.append(w); getter = () => (w.querySelector('input:checked') || {}).value || '';
    setter = (v) => { const t = Array.from(w.querySelectorAll('input')).find((i) => i.value === v); if (t) t.checked = true; };
  } else if (q.type === 'checkbox') {
    const w = el('div', { class: 'checkbox-list' });
    opts.forEach((o) => w.append(el('label', {}, el('input', { type: 'checkbox', value: o }), o)));
    label.append(w); getter = () => Array.from(w.querySelectorAll('input:checked')).map((c) => c.value);
    setter = (v) => { const want = new Set(String(v || '').split(',').map((s) => s.trim())); w.querySelectorAll('input').forEach((i) => { i.checked = want.has(i.value); }); };
  } else if (q.type === 'table') {
    label.textContent = '';
    label.style.fontWeight = '400';
    const { node, get, set } = tableField(q.text + (q.required ? ' *' : ''), q.options, !!q.multiRow);
    label.append(node); getter = get; setter = set;
  } else { const i = el('input', { type: 'text' }); label.append(i); getter = () => i.value; setter = (v) => { i.value = v || ''; }; }
  return { node: label, get: getter, set: setter };
}

/** Build a grid input: a title spanning the top, `columns` as a header row, and
 *  one or more input rows. When `multi` is true the user can add/remove rows.
 *  Returns { node, get } where get() serialises the rows as newline-separated
 *  "Col: value, ..." lines (same format questionnaire Table answers use, so the
 *  reporting Totals parser aggregates them automatically). */
function tableField(titleText, columns, multi) {
  const wrap = el('div', {});
  const cols = (columns && columns.length) ? columns : ['Value'];
  const span = cols.length + (multi ? 1 : 0);
  const rows = []; // each: { inputs: [<input>], tr }
  const tbody = el('tbody', {});
  const addRow = () => {
    const inputs = cols.map((c) => el('input', { placeholder: c }));
    const cells = inputs.map((i) => el('td', {}, i));
    if (multi) {
      cells.push(el('td', { class: 'qtable-x' },
        el('button', { type: 'button', class: 'btn danger small', title: 'Remove row',
          onclick: () => { if (rows.length <= 1) { inputs.forEach((i) => (i.value = '')); return; } const idx = rows.indexOf(rec); if (idx >= 0) { rows.splice(idx, 1); tr.remove(); } } }, '✕')));
    }
    const tr = el('tr', {}, ...cells);
    const rec = { inputs, tr };
    rows.push(rec); tbody.append(tr);
    return rec;
  };
  const headCells = cols.map((c) => el('th', {}, c));
  if (multi) headCells.push(el('th', {}));
  const table = el('table', { class: 'qtable' },
    el('thead', {},
      el('tr', {}, el('th', { colspan: String(span) }, titleText)),
      el('tr', {}, ...headCells)),
    tbody);
  addRow();
  wrap.append(table);
  if (multi) wrap.append(el('button', { type: 'button', class: 'btn small', style: 'margin-top:8px', onclick: () => addRow() }, '+ Add row'));
  const get = () => rows.map((rec) => rec.inputs.map((inp, i) => [cols[i], inp.value.trim()]))
    .filter((cells) => cells.some(([, v]) => v !== ''))
    .map((cells) => cells.map(([c, v]) => `${c}: ${v}`).join(', '))
    .join('\n');
  // Parse the serialised "Col: value, ..." lines back into the grid.
  const set = (v) => {
    const lines = String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    while (rows.length < lines.length && multi) addRow();
    lines.forEach((line, r) => {
      const rec = rows[r]; if (!rec) return;
      const map = {};
      line.split(',').forEach((p) => { const m = p.match(/^\s*(.+?):\s*(.*)$/); if (m) map[m[1].trim()] = m[2].trim(); });
      rec.inputs.forEach((inp, i) => { if (map[cols[i]] != null) inp.value = map[cols[i]]; });
    });
  };
  return { node: wrap, get, set };
}

/* ------------------------------------------------------------------ *
 * Authenticated app shell
 * ------------------------------------------------------------------ */
const PAGES = {
  admin: ['dashboard', 'departments', 'users', 'questionnaires', 'reports', 'business', 'monitoring', 'tasks', 'pendency', 'approvals', 'schedule'],
  dept_head: ['dashboard', 'team', 'departments', 'questionnaires', 'reports', 'business', 'monitoring', 'tasks', 'pendency', 'approvals', 'schedule'],
  employee: ['tasks', 'reports', 'schedule'],
};
const LABELS = { dashboard: 'Dashboard', departments: 'Departments', users: 'Users', team: 'My Team', questionnaires: 'Questionnaires', reports: 'Reports', business: 'Business Report', monitoring: 'Monitoring', tasks: 'Tasks', pendency: 'Pendency', approvals: 'Approvals', schedule: 'My Schedule' };
const ICONS = { dashboard: '📊', departments: '🏢', users: '👥', team: '👥', questionnaires: '📝', reports: '📈', business: '🏦', monitoring: '🔍', tasks: '✅', pendency: '📌', approvals: '🗂️', schedule: '📅' };
function pageLabel(p) {
  if (state.user.role === 'employee' && p === 'reports') return 'My Reports';
  if (state.user.role === 'employee' && p === 'tasks') return 'My Tasks';
  return LABELS[p];
}
function openDrawer() { const d = $('#drawer'), b = $('#drawer-backdrop'); if (d) d.classList.add('open'); if (b) b.classList.remove('hidden'); }
function closeDrawer() { const d = $('#drawer'), b = $('#drawer-backdrop'); if (d) d.classList.remove('open'); if (b) b.classList.add('hidden'); }

function enterApp() {
  root().innerHTML = '';
  const pages = PAGES[state.user.role] || ['reports'];

  // ----- Left navigation drawer -----
  const nav = el('nav', { id: 'nav' });
  pages.forEach((p) => nav.append(el('button', { class: 'nav-item', 'data-page': p, onclick: () => { navigate(p); closeDrawer(); } },
    el('span', { class: 'nav-ic' }, ICONS[p] || '•'), el('span', {}, pageLabel(p)))));
  const drawer = el('aside', { id: 'drawer', class: 'drawer' },
    el('div', { class: 'drawer-head' },
      el('div', { class: 'brand-badge' }, '☀'),
      el('div', {}, el('div', { class: 'brand' }, 'Daily Reporting'), el('div', { class: 'brand-sub' }, 'Reporting Suite')),
      el('button', { class: 'icon-btn drawer-x', title: 'Close', onclick: closeDrawer }, '✕')),
    nav,
    el('div', { class: 'drawer-foot' },
      el('div', { class: 'avatar' }, (state.user.name || '?').slice(0, 1).toUpperCase()),
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { class: 'user-label', style: 'font-weight:600' }, state.user.name),
        el('div', { class: 'role-tag' }, state.user.role.replace('_', ' '))),
      el('button', { class: 'icon-btn', title: 'Logout', onclick: () => signOut(auth) }, '⎋')));

  // ----- Top bar + content -----
  const bellCount = el('span', { id: 'bell-count', class: 'badge hidden' }, '0');
  const bell = el('button', { class: 'icon-btn bell', title: 'Notifications', onclick: toggleNotifications }, '🔔', bellCount);
  const title = el('div', { id: 'topbar-title', class: 'topbar-title' }, 'Daily Reporting');
  const content = el('div', { class: 'content' },
    el('header', { class: 'topbar' },
      el('button', { class: 'icon-btn hamburger', title: 'Menu', onclick: openDrawer }, '☰'),
      title,
      el('div', { style: 'flex:1' }),
      el('button', { class: 'icon-btn', title: 'Refresh', onclick: () => location.reload() }, '↻'),
      bell),
    el('div', { id: 'notif-panel', class: 'notif-panel hidden' }),
    el('main', { id: 'page', class: 'page' }));

  root().append(el('div', { class: 'app-layout' },
    drawer,
    el('div', { id: 'drawer-backdrop', class: 'drawer-backdrop hidden', onclick: closeDrawer }),
    content));

  navigate(pages[0]);
  refreshNotifications();
  if (!state._notifTimer) state._notifTimer = setInterval(refreshNotifications, 30000);
}

const ROUTES = {
  dashboard: renderDashboard, departments: renderDepartments,
  users: () => renderUsers(false), team: () => renderUsers(true),
  questionnaires: renderQuestionnaires, reports: renderReports, business: renderBusinessReport, monitoring: renderMonitoring, tasks: renderTasks,
  pendency: renderPendency, approvals: renderApprovals, schedule: renderSchedule,
};
function navigate(page) {
  state.page = page;
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  const t = $('#topbar-title'); if (t) t.textContent = pageLabel(page) || 'Daily Reporting';
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
    const paths = computePaths(departments);
    const isHead = state.user.role === 'dept_head';
    // a head sees/manages only their own subtree
    const inScope = (d) => !isHead || (paths[d.id] || []).includes(state.user.departmentId);
    const visible = departments.filter(inScope);
    const ordered = visible.slice().sort((a, b) =>
      (paths[a.id] || []).map((id) => deptName(departments, id)).join('/').localeCompare(
        (paths[b.id] || []).map((id) => deptName(departments, id)).join('/')));
    const head = pageHead(isHead ? 'Sub-departments' : 'Departments',
      [el('button', { class: 'btn primary', style: 'width:auto', onclick: () => departmentModal(null, users, departments) }, isHead ? '+ New sub-department' : '+ New department')]);
    if (!visible.length) return [head, el('div', { class: 'empty' }, isHead ? 'No sub-departments yet. Add one under your department.' : 'No departments yet. The first one is your top-level branch.')];
    const tbody = el('tbody');
    // members roll up: a department "contains" everyone in its subtree
    const totalMembers = (id) => users.filter((u) => (u.deptPath || []).includes(id)).length;
    const directMembers = (id) => users.filter((u) => u.departmentId === id).length;
    ordered.forEach((d) => {
      const depth = (paths[d.id] || [d.id]).length - 1;
      const total = totalMembers(d.id); const direct = directMembers(d.id);
      const membersLabel = total === direct ? String(total) : `${total} (${direct} direct)`;
      const headName = (users.find((u) => u.id === d.headUserId) || {}).name || '—';
      const label = (depth ? '—'.repeat(depth) + ' ' : '') + d.name;
      const canManage = state.user.role === 'admin' || d.id !== state.user.departmentId; // heads can't edit their own dept
      tbody.append(el('tr', {},
        el('td', {}, el('span', depth ? { class: 'muted' } : {}, label), depth ? null : el('span', { class: 'pill dept_head', style: 'margin-left:8px' }, 'branch')),
        el('td', {}, headName), el('td', {}, membersLabel),
        el('td', {}, el('div', { class: 'row-actions' },
          canManage ? el('button', { class: 'btn ghost small', onclick: () => departmentModal(d, users, departments) }, 'Edit') : null,
          canManage ? el('button', { class: 'btn danger small', onclick: () => delDepartment(d, users, departments) }, 'Delete') : null))));
    });
    return [head,
      el('p', { class: 'muted', style: 'margin:0 0 12px' }, 'Members count includes everyone in the department and all its sub-departments.'),
      el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Department'), el('th', {}, 'Head'), el('th', {}, 'Members'), el('th', {}, ''))), tbody)];
  });
}

function departmentModal(dept, users, departments) {
  const isHead = state.user.role === 'dept_head';
  const name = el('input', { value: dept ? dept.name : '', required: true });
  const paths = computePaths(departments);
  // a department cannot be its own parent or a child of its own descendants
  const descendantIds = dept ? new Set(departments.filter((x) => (paths[x.id] || []).includes(dept.id)).map((x) => x.id)) : new Set();
  let parentOptions = departments.filter((x) => !descendantIds.has(x.id));
  // a head can only place departments within their own subtree
  if (isHead) parentOptions = parentOptions.filter((x) => (paths[x.id] || []).includes(state.user.departmentId));
  const parent = el('select', {},
    ...(isHead ? [] : [el('option', { value: '' }, '— none (top-level branch) —')]),
    ...parentOptions.map((p) => el('option', { value: p.id, selected: (dept && dept.parentId === p.id) || (!dept && isHead && p.id === state.user.departmentId) }, p.name)));
  const head = el('select', {}, el('option', { value: '' }, '— none —'),
    ...users.filter((u) => u.authUid).map((u) => el('option', { value: u.id, selected: dept && dept.headUserId === u.id }, `${u.name} (${u.email || u.uniqueId})`)));
  modal(dept ? 'Edit department' : (isHead ? 'New sub-department' : 'New department'),
    el('div', {},
      el('label', {}, 'Name', name),
      el('label', {}, 'Parent department', parent),
      el('label', {}, 'Department head (must have a login)', head)), async () => {
      const headId = head.value || null;
      const parentId = parent.value || null;
      if (isHead && !parentId) throw new Error('Choose a parent department within your branch.');
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
const Q_TYPES = [['text', 'Short text'], ['textarea', 'Long text'], ['number', 'Number'], ['date', 'Date'], ['select', 'Dropdown'], ['radio', 'Single choice'], ['checkbox', 'Multiple choice'], ['table', 'Table (multiple rows)']];

// Can the current user edit/delete this questionnaire directly (admin or a
// strict superior of its department)? Otherwise changes go through approval.
function canDirectEditQ(q) {
  if (state.user.role === 'admin') return true;
  if (state.user.role === 'dept_head') {
    const dp = q.deptPath || [];
    return dp.includes(state.user.departmentId) && state.user.departmentId !== q.departmentId;
  }
  return false;
}
async function requestQuestionnaireChange(type, q, proposed) {
  await addDoc(colRef('approvals'), {
    type, questionnaireId: q.id, questionnaireTitle: q.title,
    departmentId: q.departmentId ?? null, deptPath: q.deptPath || [],
    requestedBy: state.user.uid, requestedByName: state.user.name,
    proposed: proposed || null, status: 'pending', createdAt: serverTimestamp(),
  });
  toast('Submitted for approval');
}
async function resolveApproval(a, approve) {
  const batch = writeBatch(db);
  if (approve && a.type === 'update' && a.proposed) {
    batch.update(doc(db, 'questionnaires', a.questionnaireId), a.proposed);
  } else if (approve && a.type === 'delete') {
    const [assigns, users] = await Promise.all([getWhere('assignments', 'questionnaireId', a.questionnaireId).catch(() => []), listUsers().catch(() => [])]);
    const uidById = Object.fromEntries(users.map((u) => [u.id, u.uniqueId]));
    assigns.forEach((x) => {
      batch.delete(doc(db, 'assignments', x.id));
      const code = uidById[x.userId];
      if (code) batch.update(doc(db, 'codes', code), { questionnaires: arrayRemove({ assignmentId: x.id, questionnaireId: a.questionnaireId, title: a.questionnaireTitle }) });
    });
    batch.delete(doc(db, 'questionnaires', a.questionnaireId));
  }
  batch.update(doc(db, 'approvals', a.id), { status: approve ? 'approved' : 'rejected', resolvedBy: state.user.uid, resolvedAt: serverTimestamp() });
  await batch.commit();
  addDoc(colRef('notifications'), { userId: a.requestedBy, message: `Your questionnaire ${a.type} for "${a.questionnaireTitle}" was ${approve ? 'approved' : 'rejected'}.`, type: 'approval', relatedId: a.questionnaireId, isRead: false, createdAt: serverTimestamp() }).catch(() => {});
  toast(approve ? 'Approved' : 'Rejected');
}

async function listApprovals() {
  const rows = state.user.role === 'admin' ? await getAll('approvals') : await getSubtree('approvals');
  return rows.sort(byCreatedDesc);
}
async function renderApprovals() {
  await withPage(async () => {
    const rows = await listApprovals();
    const canApprove = (a) => a.status === 'pending' && (state.user.role === 'admin' || (a.departmentId !== state.user.departmentId && (a.deptPath || []).includes(state.user.departmentId)));
    const toApprove = rows.filter(canApprove);
    const mine = rows.filter((a) => a.requestedBy === state.user.uid);
    const head = pageHead('Approvals');
    const out = [head];
    out.push(el('h3', {}, 'Pending your approval'));
    if (!toApprove.length) out.push(el('p', { class: 'muted' }, 'Nothing waiting on you.'));
    else toApprove.forEach((a) => out.push(el('div', { class: 'q-builder-item' },
      el('div', {}, el('strong', {}, `${a.type} · ${a.questionnaireTitle}`),
        el('div', { class: 'muted', style: 'font-size:12px' }, `requested by ${a.requestedByName || '—'} · ${fmtDate(a.createdAt)}`)),
      el('div', { class: 'inline', style: 'margin-top:8px' },
        el('button', { class: 'btn primary', style: 'width:auto', onclick: async () => { try { await resolveApproval(a, true); renderApprovals(); } catch (e) { toast(friendlyError(e), true); } } }, 'Approve'),
        el('button', { class: 'btn danger', style: 'width:auto', onclick: async () => { try { await resolveApproval(a, false); renderApprovals(); } catch (e) { toast(friendlyError(e), true); } } }, 'Reject')))));
    out.push(el('h3', { style: 'margin-top:24px' }, 'My requests'));
    if (!mine.length) out.push(el('p', { class: 'muted' }, 'You have not submitted any.'));
    else mine.forEach((a) => out.push(el('div', { class: 'q-builder-item', style: 'display:flex;align-items:center;gap:10px' },
      el('div', { style: 'flex:1' }, el('strong', {}, `${a.type} · ${a.questionnaireTitle}`),
        el('span', { class: 'pill ' + (a.status === 'approved' ? 'done' : a.status === 'rejected' ? 'pending' : 'in_progress'), style: 'margin-left:8px' }, a.status)),
      a.status === 'pending' ? el('button', { class: 'btn danger small', onclick: async () => {
        if (!confirm('Cancel this pending request?')) return;
        try { await deleteDoc(doc(db, 'approvals', a.id)); toast('Cancelled'); renderApprovals(); } catch (e) { toast(friendlyError(e), true); }
      } }, 'Cancel') : null)));
    return out;
  });
}
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
    const multiRow = el('input', { type: 'checkbox', ...(q.multiRow ? { checked: true } : {}) });
    const multiRowLabel = el('label', { style: 'margin:0;font-weight:400' }, multiRow, ' allow adding rows');
    // Expected performance target(s) — number: one value; table: one per column.
    const target = el('input', { type: 'number', step: 'any', placeholder: 'Target, e.g. 3', value: (q.target != null ? String(q.target) : '') });
    const colTargets = el('input', { placeholder: 'Targets per column, e.g. 3, 5000', value: (q.colTargets || []).join(', ') });
    const period = el('select', {}, ...[['daily', 'per day'], ['weekly', 'per week'], ['monthly', 'per month']].map(([v, l]) => el('option', { value: v, selected: (q.targetPeriod || 'daily') === v }, l)));
    const targetRow = el('div', { class: 'q-row' }, el('span', { class: 'muted', style: 'font-size:12px' }, 'Expected'), target, colTargets, period);
    const toggle = () => {
      const show = ['select', 'radio', 'checkbox', 'table'].includes(type.value);
      options.style.display = show ? '' : 'none';
      options.placeholder = type.value === 'table' ? 'Columns, e.g. Number of leads, Amount' : 'Options (comma separated)';
      multiRowLabel.style.display = type.value === 'table' ? '' : 'none';
      target.style.display = type.value === 'number' ? '' : 'none';
      colTargets.style.display = type.value === 'table' ? '' : 'none';
      targetRow.style.display = (type.value === 'number' || type.value === 'table') ? '' : 'none';
    };
    type.addEventListener('change', toggle);
    const moveUp = el('button', { type: 'button', class: 'btn ghost small', title: 'Move up', onclick: () => { if (item.previousElementSibling) qWrap.insertBefore(item, item.previousElementSibling); } }, '▲');
    const moveDown = el('button', { type: 'button', class: 'btn ghost small', title: 'Move down', onclick: () => { if (item.nextElementSibling) qWrap.insertBefore(item.nextElementSibling, item); } }, '▼');
    item.append(el('div', { class: 'q-row' }, text, moveUp, moveDown, el('button', { type: 'button', class: 'btn danger small', title: 'Remove', onclick: () => item.remove() }, '✕')),
      el('div', { class: 'q-row' }, type, el('label', { style: 'margin:0;font-weight:400' }, required, ' required'), multiRowLabel), options, targetRow);
    toggle();
    item._get = () => {
      const base = { id: qid, text: text.value.trim(), type: type.value, required: required.checked, multiRow: type.value === 'table' && multiRow.checked, options: options.value.split(',').map((s) => s.trim()).filter(Boolean) };
      if (type.value === 'number') { const t = parseFloat(target.value); if (!isNaN(t)) { base.target = t; base.targetPeriod = period.value; } }
      else if (type.value === 'table') { const ts = colTargets.value.split(',').map((s) => { const n = parseFloat(s.trim()); return isNaN(n) ? null : n; }); if (ts.some((n) => n != null)) { base.colTargets = ts; base.targetPeriod = period.value; } }
      return base;
    };
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
  const needsApproval = existing && !canDirectEditQ(existing);
  const submitLabel = needsApproval ? 'Submit for approval' : (existing ? 'Save changes' : 'Create');
  modal(existing ? 'Edit questionnaire' : 'New questionnaire', content, async () => {
    const questions = Array.from(qWrap.querySelectorAll('.q-builder-item')).map((n, i) => ({ ...n._get(), position: i })).filter((q) => q.text);
    if (!questions.length) throw new Error('Add at least one question');
    const departmentId = isAdmin ? (deptSel.value || null) : (existing ? existing.departmentId ?? null : state.user.departmentId);
    const deptPath = deptPathOf(departmentId, departments);
    const payload = { title: title.value.trim(), description: desc.value.trim(), questions, departmentId, deptPath };
    if (needsApproval) { await requestQuestionnaireChange('update', existing, payload); renderQuestionnaires(); return; }
    if (existing) await updateDoc(doc(db, 'questionnaires', existing.id), payload);
    else await addDoc(colRef('questionnaires'), { ...payload, active: true, createdBy: state.user.uid, createdAt: serverTimestamp() });
    toast('Questionnaire saved'); renderQuestionnaires();
  }, submitLabel);
}
async function delQuestionnaire(q) {
  if (!canDirectEditQ(q)) {
    if (!confirm(`Request deletion of "${q.title}"? A superior department must approve it.`)) return;
    try { await requestQuestionnaireChange('delete', q); } catch (e) { toast(friendlyError(e), true); }
    return;
  }
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

/* ---- Reports & analytics ---- */
function localYmd(d = new Date()) { const off = d.getTimezoneOffset() * 60000; return new Date(d - off).toISOString().slice(0, 10); }
function submittedYmd(r) { const d = r.submittedAt && r.submittedAt.toDate ? r.submittedAt.toDate() : (r.submittedAt ? new Date(r.submittedAt) : null); return d ? localYmd(d) : ''; }
async function listAssignments() { return state.user.role === 'admin' ? getAll('assignments') : getSubtree('assignments'); }
const toNum = (s) => { const n = parseFloat(String(s).replace(/,/g, '').trim()); return isNaN(n) ? null : n; };
// Pull numeric metrics out of answers: a plain Number answer, or each numeric
// "Column: value" pair inside a Table answer.
function reportMetrics(reports) {
  const map = {};
  const add = (key, n) => { (map[key] || (map[key] = { sum: 0, count: 0 })); map[key].sum += n; map[key].count += 1; };
  reports.forEach((r) => (r.answers || []).forEach((a) => {
    const v = (a.value == null ? '' : String(a.value)).trim();
    if (!v) return;
    const parts = v.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    let pair = false;
    parts.forEach((p) => { const m = p.match(/^(.+?):\s*(.+)$/); if (m) { const n = toNum(m[2]); if (n !== null) { pair = true; add(`${a.question} — ${m[1].trim()}`, n); } } });
    if (!pair) { const n = toNum(v); if (n !== null) add(a.question, n); }
  }));
  return map;
}
const fmtNum = (n) => (Math.round(n * 100) / 100).toLocaleString();

/* ---- Performance targets & feedback ---- */
// Convert a period target to a per-day figure (working-day estimates).
const PERIOD_DAYS = { daily: 1, weekly: 6, monthly: 26 };
const PERIOD_LABEL = { daily: 'per day', weekly: 'per week', monthly: 'per month' };
// Numeric metrics a questionnaire defines, as { key, label, daily, period }.
function questionTargets(qn) {
  const out = [];
  (qn.questions || []).forEach((q) => {
    const period = q.targetPeriod || 'daily';
    const per = PERIOD_DAYS[period] || 1;
    if (q.type === 'number' && q.target != null) out.push({ key: q.id, label: q.text, daily: q.target / per, period });
    else if (q.type === 'table' && Array.isArray(q.colTargets)) {
      (q.options || []).forEach((col, i) => { const t = q.colTargets[i]; if (t != null) out.push({ key: `${q.id}::${col}`, label: `${q.text} — ${col}`, daily: t / per, period }); });
    }
  });
  return out;
}
// Apply per-employee daily overrides stored on the code doc (targets map by key).
function effectiveTargets(qn, overrides) {
  return questionTargets(qn).map((t) => (overrides && overrides[t.key] != null) ? { ...t, daily: overrides[t.key], overridden: true } : t);
}
// Actual numeric values for one report's answers, keyed like questionTargets.
function answerMetrics(answers, questions) {
  const qById = Object.fromEntries((questions || []).map((q) => [q.id, q]));
  const map = {};
  (answers || []).forEach((a) => {
    const q = qById[a.questionId]; if (!q) return;
    if (q.type === 'number') { const n = toNum(a.value); if (n != null) map[a.questionId] = (map[a.questionId] || 0) + n; }
    else if (q.type === 'table') {
      String(a.value || '').split(/[\n,]+/).forEach((p) => { const m = p.match(/^\s*(.+?):\s*(.+)$/); if (m) { const n = toNum(m[2]); if (n != null) { const k = `${q.id}::${m[1].trim()}`; map[k] = (map[k] || 0) + n; } } });
    }
  });
  return map;
}
// Judge a set of attainment ratios → { tier, message }.
function performanceVerdict(ratios) {
  if (!ratios.length) return null;
  const avg = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  if (avg >= 1) return { tier: 'excellent', message: 'Excellent — you met or exceeded today’s target. Great work! 🎉' };
  if (avg >= 0.7) return { tier: 'good', message: 'Good — close to target. A little more gets you there.' };
  return { tier: 'below', message: 'Below expectation — kindly improve.' };
}
// A feedback card comparing one report's actuals to the daily targets.
function performanceCard(qn, codeData, answers) {
  const targets = effectiveTargets(qn, codeData && codeData.targets).filter((t) => t.daily > 0);
  if (!targets.length) return null;
  const actual = answerMetrics(answers, qn.questions);
  const ratios = [], rows = [];
  targets.forEach((t) => {
    const a = actual[t.key] || 0;
    ratios.push(a / t.daily);
    rows.push(el('div', { style: 'font-size:14px' }, `${t.label}: `, el('strong', {}, fmtNum(a)), el('span', { class: 'muted' }, ` / ${fmtNum(t.daily)} expected`)));
  });
  const v = performanceVerdict(ratios);
  if (!v) return null;
  return el('div', { class: `perf perf-${v.tier}` },
    el('div', { style: 'font-weight:700;margin-bottom:6px' }, v.message), ...rows);
}

async function renderReports() {
  await withPage(async () => {
    const isEmployee = state.user.role === 'employee';
    const [reports, assignments, users, departments] = await Promise.all([
      listReports(),
      isEmployee ? Promise.resolve([]) : listAssignments().catch(() => []),
      isEmployee ? Promise.resolve([]) : listUsers().catch(() => []),
      isEmployee ? Promise.resolve([]) : listDepartments().catch(() => []),
    ]);
    const nameById = Object.fromEntries(users.map((u) => [u.id, u.name]));

    // filter options derived from the data
    const qOpts = [...new Map(reports.map((r) => [r.questionnaireId, r.questionnaireTitle])).entries()];
    const uOpts = [...new Map(reports.map((r) => [r.userId, r.userName])).entries()];

    const f = { from: '', to: '', questionnaireId: '', userId: '', departmentId: '' };
    let filtered = reports;

    const exportBtn = el('button', { class: 'btn', style: 'width:auto', onclick: () => exportCsv(filtered) }, '⭳ Export CSV');
    const head = pageHead(isEmployee ? 'My Reports' : 'Reports', reports.length ? [exportBtn] : []);
    if (!reports.length) return [head, el('div', { class: 'empty' }, isEmployee ? 'You have not submitted any reports yet.' : 'No reports submitted yet.')];

    const fromI = el('input', { type: 'date' });
    const toI = el('input', { type: 'date' });
    const qSel = el('select', {}, el('option', { value: '' }, 'All questionnaires'), ...qOpts.map(([id, t]) => el('option', { value: id }, t)));
    const uSel = el('select', {}, el('option', { value: '' }, 'All people'), ...uOpts.map(([id, n]) => el('option', { value: id }, n)));
    const dSel = el('select', {}, el('option', { value: '' }, 'All departments'), ...departments.map((d) => el('option', { value: d.id }, d.name)));
    const setPreset = (days) => { toI.value = localYmd(); fromI.value = days == null ? '' : localYmd(new Date(Date.now() - days * 86400000)); if (days === null) toI.value = ''; sync(); };
    const presets = el('div', { class: 'inline', style: 'gap:6px' },
      el('button', { class: 'btn ghost small', onclick: () => setPreset(0) }, 'Today'),
      el('button', { class: 'btn ghost small', onclick: () => setPreset(6) }, '7 days'),
      el('button', { class: 'btn ghost small', onclick: () => setPreset(29) }, '30 days'),
      el('button', { class: 'btn ghost small', onclick: () => setPreset(null) }, 'All'));

    const filterBar = el('div', { class: 'tile', style: 'margin-bottom:14px' },
      presets,
      el('div', { class: 'inline', style: 'margin-top:10px' },
        el('label', { style: 'flex:1;margin:0' }, 'From', fromI),
        el('label', { style: 'flex:1;margin:0' }, 'To', toI)),
      el('div', { class: 'inline', style: 'margin-top:10px' },
        el('label', { style: 'flex:1;margin:0' }, 'Questionnaire', qSel),
        isEmployee ? null : el('label', { style: 'flex:1;margin:0' }, 'Person', uSel),
        isEmployee ? null : el('label', { style: 'flex:1;margin:0' }, 'Department', dSel)));

    const results = el('div', {});

    function sync() {
      f.from = fromI.value; f.to = toI.value; f.questionnaireId = qSel.value; f.userId = uSel.value; f.departmentId = dSel.value;
      const fromMs = f.from ? new Date(f.from + 'T00:00:00').getTime() : -Infinity;
      const toMs = f.to ? new Date(f.to + 'T23:59:59').getTime() : Infinity;
      filtered = reports.filter((r) => {
        const ms = millis(r.submittedAt);
        if (ms < fromMs || ms > toMs) return false;
        if (f.questionnaireId && r.questionnaireId !== f.questionnaireId) return false;
        if (f.userId && r.userId !== f.userId) return false;
        if (f.departmentId && !(r.deptPath || []).includes(f.departmentId)) return false;
        return true;
      });
      renderResults();
    }

    function renderResults() {
      results.innerHTML = '';
      const uniqueReporters = new Set(filtered.map((r) => r.userId)).size;
      const tiles = [tile('Reports', filtered.length, 'in filter'), tile('People reporting', uniqueReporters, 'unique')];

      // daily coverage (managers): who was assigned but hasn't reported today
      if (!isEmployee && assignments.length) {
        const today = localYmd();
        const assignedIds = [...new Set(assignments.map((a) => a.userId))];
        const reportedToday = new Set(reports.filter((r) => submittedYmd(r) === today).map((r) => r.userId));
        const missing = assignedIds.filter((id) => !reportedToday.has(id));
        tiles.push(tile('Reported today', `${assignedIds.length - missing.length}/${assignedIds.length}`, 'of assigned'));
        results.append(el('div', { class: 'grid' }, ...tiles));
        if (missing.length) {
          results.append(el('details', { style: 'margin:12px 0' },
            el('summary', { style: 'cursor:pointer;color:var(--warn);font-weight:600' }, `${missing.length} not reported today`),
            el('div', { class: 'muted', style: 'padding:8px 0' }, missing.map((id) => nameById[id] || id).join(', '))));
        }
      } else {
        results.append(el('div', { class: 'grid' }, ...tiles));
      }

      // numeric totals
      const metrics = reportMetrics(filtered);
      const keys = Object.keys(metrics).sort();
      if (keys.length) {
        const tbody = el('tbody');
        keys.forEach((k) => { const m = metrics[k]; tbody.append(el('tr', {}, el('td', {}, k), el('td', {}, el('strong', {}, fmtNum(m.sum))), el('td', {}, fmtNum(m.sum / m.count)), el('td', {}, String(m.count)))); });
        results.append(el('h3', { style: 'margin-top:20px' }, 'Totals'),
          el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Metric'), el('th', {}, 'Total'), el('th', {}, 'Average'), el('th', {}, 'Entries'))), tbody));
      }

      results.append(el('h3', { style: 'margin-top:20px' }, `Reports (${filtered.length})`), reportsTable(filtered));
    }

    [fromI, toI, qSel, uSel, dSel].forEach((c) => c.addEventListener('change', sync));
    renderResults();
    return [head, filterBar, results];
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
  const isManager = state.user.role === 'admin' || state.user.role === 'dept_head';
  const content = el('div', {}, el('p', { class: 'muted' }, `${r.userName} · ${fmtDate(r.submittedAt)}`),
    ...(r.answers || []).map((a) => el('div', { class: 'report-answer' }, el('div', { class: 'q' }, a.question), el('div', { class: 'a' }, a.value || '—'))));
  const backdrop = el('div', { class: 'modal-backdrop' });
  const actions = el('div', { class: 'modal-actions' });
  if (isManager) actions.append(el('button', { class: 'btn danger', style: 'width:auto;margin-right:auto', onclick: async () => {
    if (!confirm('Delete this report? This cannot be undone.')) return;
    try { await deleteDoc(doc(db, 'submissions', r.id)); backdrop.remove(); toast('Report deleted'); navigate(state.page); }
    catch (e) { toast(friendlyError(e), true); }
  } }, 'Delete'));
  actions.append(el('button', { class: 'btn primary', style: 'width:auto', onclick: () => backdrop.remove() }, 'Close'));
  backdrop.append(el('div', { class: 'modal' }, el('h3', {}, r.questionnaireTitle), content, actions));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
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

/* ---- Monitoring (per-employee performance + manager feedback) ---- */
function monitorWindowStart(period) {
  const d = new Date();
  if (period === 'today') return localYmd();
  if (period === 'week') { const back = (d.getDay() + 6) % 7; d.setDate(d.getDate() - back); return localYmd(d); }
  return localYmd(new Date(d.getFullYear(), d.getMonth(), 1)); // month
}
const subYmd = (r) => r.reportDate || submittedYmd(r);

async function renderMonitoring() {
  await withPage(async () => {
    const [users, submissions, questionnaires] = await Promise.all([
      listUsers().catch(() => []),
      listReports().catch(() => []),
      listQuestionnaires().catch(() => []),
    ]);
    const head = pageHead('Monitoring');
    const qById = Object.fromEntries(questionnaires.map((q) => [q.id, q]));
    const staff = users.filter((u) => u.id !== state.user.uid && u.role !== 'admin');
    if (!staff.length) return [head, el('div', { class: 'empty' }, 'No team members to monitor yet.')];

    // Load each person's code doc (targets overrides + observations).
    const codes = {};
    await Promise.all(staff.map(async (u) => {
      if (!u.uniqueId) return;
      try { const s = await getDoc(doc(db, 'codes', u.uniqueId)); if (s.exists()) codes[u.id] = { id: u.uniqueId, ...s.data() }; } catch { /* ignore */ }
    }));

    let period = 'month';
    let staffId = '';
    const results = el('div', {});
    const mkBtn = (p, label) => el('button', { class: 'btn ghost small', 'data-p': p, onclick: () => { period = p; sync(); } }, label);
    const empSel = el('select', { style: 'width:auto;min-width:180px', onchange: () => { staffId = empSel.value; sync(); } },
      el('option', { value: '' }, 'All employees'),
      ...staff.slice().sort((a, b) => String(a.name || '').localeCompare(b.name || '')).map((u) => el('option', { value: u.id }, u.name)));
    const controls = el('div', { class: 'inline', style: 'gap:6px;margin-bottom:14px;flex-wrap:wrap' },
      mkBtn('today', 'Today'), mkBtn('week', 'This week'), mkBtn('month', 'This month'),
      el('label', { style: 'margin:0;font-weight:400' }, empSel));

    function metricsFor(u) {
      const from = monitorWindowStart(period), today = localYmd();
      const subs = submissions.filter((r) => r.userId === u.id && subYmd(r) >= from && subYmd(r) <= today);
      const days = new Set(subs.map(subYmd)).size;
      const actual = {};
      subs.forEach((r) => { const m = answerMetrics(r.answers, (qById[r.questionnaireId] || {}).questions); Object.entries(m).forEach(([k, v]) => { actual[k] = (actual[k] || 0) + v; }); });
      const tgts = {};
      new Set(subs.map((r) => r.questionnaireId)).forEach((qid) => { const qn = qById[qid]; if (qn) effectiveTargets(qn, codes[u.id] && codes[u.id].targets).forEach((t) => { tgts[t.key] = t; }); });
      return { subs, days, actual, tgts };
    }

    function perfCell(m) {
      const keys = Object.keys(m.tgts);
      if (!keys.length) return el('span', { class: 'muted' }, m.subs.length ? 'no targets set' : 'no reports');
      const wrap = el('div', {});
      const ratios = [];
      keys.forEach((k) => {
        const t = m.tgts[k];
        const expected = t.daily * (m.days || 0);
        const act = m.actual[k] || 0;
        const pct = expected > 0 ? act / expected : null;
        if (pct != null) ratios.push(pct);
        const tier = pct == null ? '' : pct >= 1 ? 'perf-excellent' : pct >= 0.7 ? 'perf-good' : 'perf-below';
        wrap.append(el('div', { class: 'perf-line ' + tier, style: 'font-size:13px' },
          `${t.label}: `, el('strong', {}, fmtNum(act)), el('span', { class: 'muted' }, ` / ${fmtNum(expected)}`),
          pct != null ? el('span', {}, ` (${Math.round(pct * 100)}%)`) : null));
      });
      return wrap;
    }

    function sync() {
      controls.querySelectorAll('.btn').forEach((b) => b.classList.toggle('primary', b.dataset.p === period));
      results.innerHTML = '';
      const shown = staffId ? staff.filter((u) => u.id === staffId) : staff;
      if (!shown.length) { results.append(el('div', { class: 'empty' }, 'No matching employee.')); return; }
      const tbody = el('tbody');
      shown.forEach((u) => {
        const m = metricsFor(u);
        const code = codes[u.id];
        const lastObs = ((code && code.observations) || []).slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0];
        tbody.append(el('tr', {},
          el('td', {}, el('div', {}, el('strong', {}, u.name), el('div', { class: 'muted', style: 'font-size:12px' }, u.role === 'dept_head' ? 'dept head' : 'employee'))),
          el('td', {}, `${m.subs.length} report(s)`, el('div', { class: 'muted', style: 'font-size:12px' }, `${m.days} day(s)`)),
          el('td', {}, perfCell(m)),
          el('td', {}, lastObs ? el('div', {}, el('div', { style: 'font-size:13px' }, lastObs.message), lastObs.reply ? el('div', { class: 'muted', style: 'font-size:12px' }, '↳ ' + lastObs.reply) : el('div', { class: 'muted', style: 'font-size:12px' }, 'awaiting reply')) : el('span', { class: 'muted' }, '—')),
          el('td', {}, el('div', { class: 'row-actions' },
            el('button', { class: 'btn ghost small', onclick: () => viewEmployeeReports(u, code, submissions.filter((r) => r.userId === u.id), qById) }, `Reports (${m.subs.length})`),
            el('button', { class: 'btn ghost small', onclick: () => commentModal(u, code) }, 'Comment'),
            el('button', { class: 'btn ghost small', onclick: () => targetsModal(u, code, qById) }, 'Targets')))));
      });
      results.append(el('table', {}, el('thead', {}, el('tr', {},
        el('th', {}, 'Employee'), el('th', {}, 'Activity'), el('th', {}, `Performance (${period})`), el('th', {}, 'Last feedback'), el('th', {}, ''))), tbody));
    }
    sync();
    return [head, el('p', { class: 'muted', style: 'margin:0 0 12px;font-size:13px' }, 'Performance compares each person’s totals to their expected target × the days they reported. Comment to give feedback (they see it and can reply on their next report); Targets sets per-person expectations.'), controls, results];
  });
}

function commentModal(u, code) {
  const ta = el('textarea', { placeholder: 'e.g. Your performance is excellent — keep it up. / Below expectation, kindly improve.' });
  modal('Comment · ' + u.name, el('div', {},
    el('p', { class: 'muted', style: 'font-size:13px' }, 'This appears when the employee next opens to report, and they can reply.'),
    el('label', {}, 'Observation on performance', ta)), async () => {
    const text = ta.value.trim(); if (!text) throw new Error('Please write an observation.');
    if (!code) throw new Error('This employee has no reporting ID to receive feedback.');
    const obs = ((code.observations) || []).concat([{ id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), message: text, fromName: state.user.name, fromUid: state.user.uid, at: new Date().toISOString(), reply: null }]);
    await updateDoc(doc(db, 'codes', code.id), { observations: obs });
    if (u.authUid) addDoc(colRef('notifications'), { userId: u.id, message: 'New performance feedback from ' + state.user.name, type: 'feedback', isRead: false, createdAt: serverTimestamp() }).catch(() => {});
    toast('Feedback sent'); renderMonitoring();
  }, 'Send feedback');
}

function targetsModal(u, code, qById) {
  if (!code) { toast('This employee has no reporting ID.', true); return; }
  // Candidate metrics = targets from the questionnaires assigned to this person.
  const assignedQids = (code.questionnaires || []).map((e) => e.questionnaireId);
  const seen = new Set(); const metrics = [];
  assignedQids.forEach((qid) => { const qn = qById[qid]; if (qn) questionTargets(qn).forEach((t) => { if (!seen.has(t.key)) { seen.add(t.key); metrics.push(t); } }); });
  if (!metrics.length) { toast('Assign a questionnaire with numeric targets first.', true); return; }
  const overrides = (code.targets) || {};
  const inputs = metrics.map((t) => {
    const cur = overrides[t.key] != null ? overrides[t.key] : t.daily;
    const inp = el('input', { type: 'number', step: 'any', value: String(cur) });
    return { t, inp };
  });
  modal('Targets · ' + u.name, el('div', {},
    el('p', { class: 'muted', style: 'font-size:13px' }, 'Daily expected value per metric for this person. Overrides the questionnaire default.'),
    ...inputs.map(({ t, inp }) => el('label', {}, `${t.label} — expected per day`, inp))), async () => {
    const next = {};
    inputs.forEach(({ t, inp }) => { const n = parseFloat(inp.value); if (!isNaN(n)) next[t.key] = n; });
    await updateDoc(doc(db, 'codes', code.id), { targets: next });
    toast('Targets saved'); renderMonitoring();
  }, 'Save targets');
}

// See an employee's submitted reports; open a day to read it, then comment.
function viewEmployeeReports(u, code, subs, qById) {
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'inline', style: 'justify-content:flex-end;margin-bottom:8px' },
    el('button', { class: 'btn small', onclick: () => commentModal(u, code) }, '💬 Comment on performance')));
  if (!subs.length) { wrap.append(el('p', { class: 'muted' }, 'No reports submitted yet.')); infoModal('Reports · ' + u.name, wrap); return; }
  subs.slice().sort((a, b) => String(subYmd(b)).localeCompare(String(subYmd(a)))).forEach((r) => {
    const qn = qById[r.questionnaireId];
    const body = el('div', { class: 'hidden', style: 'padding:10px 12px;border:1px solid var(--line);border-top:none;border-radius:0 0 8px 8px' });
    (r.answers || []).forEach((a) => body.append(el('div', { class: 'report-answer' }, el('div', { class: 'q' }, a.question), el('div', { class: 'a' }, a.value || '—'))));
    // per-metric attainment against this person's daily targets
    const targets = qn ? effectiveTargets(qn, code && code.targets).filter((t) => t.daily > 0) : [];
    if (targets.length) {
      const actual = answerMetrics(r.answers, qn.questions);
      const perf = el('div', { style: 'margin-top:8px' });
      targets.forEach((t) => {
        const a = actual[t.key] || 0; const pct = a / t.daily;
        const tier = pct >= 1 ? 'perf-excellent' : pct >= 0.7 ? 'perf-good' : 'perf-below';
        perf.append(el('div', { class: 'perf-line ' + tier, style: 'font-size:13px' },
          `${t.label}: `, el('strong', {}, fmtNum(a)), el('span', { class: 'muted' }, ` / ${fmtNum(t.daily)} expected`), el('span', {}, ` (${Math.round(pct * 100)}%)`)));
      });
      body.append(perf);
    }
    body.append(el('button', { class: 'btn small', style: 'margin-top:10px', onclick: () => commentModal(u, code) }, '💬 Comment on performance'));
    const header = el('button', { class: 'btn ghost', style: 'width:100%;justify-content:space-between;text-align:left;border-radius:8px', onclick: () => body.classList.toggle('hidden') },
      el('span', {}, `${subYmd(r)} · ${r.questionnaireTitle || 'Report'}`), el('span', { class: 'muted' }, `${(r.answers || []).length} answers ▾`));
    wrap.append(el('div', { style: 'margin-bottom:8px' }, header, body));
  });
  infoModal('Reports · ' + u.name, wrap);
}

/* ---- Cumulative Business Report (matches the branch daily business form) ---- */
// The 40 numeric metrics of the "Branches daily business report" form, in order.
const BUSINESS_FIELDS = [
  'NO. OF NON FI SB ACCOUNT OPENED',
  'NON FI SB ACCOUNT AMOUNT (IN ACTUALS)',
  'NO. OF CURRENT ACCOUNTS OPENED',
  'CURRENT ACCOUNT AMOUNT (IN ACTUALS)',
  'NO OF SALARY ACCOUNTS OPENED',
  'NO OF QUALITY CASA ACCOUNTS OPENED>25000',
  'INCREMENT/DECLINE IN CASA DURING THE DAY (AMT IN ACTUALS)',
  'NO OF RETAIL TERM DEPOSIT ACCOUNTS OPENED',
  'RETAIL TERM DEPOSIT ACCOUNTS OPENED (AMOUNT IN ACTUALS)',
  'NO OF DORMANT ACCOUNTS ACTIVATED',
  'DORMANT ACCOUNT ACTIVATION AMOUNT',
  'NO OF DEAF ACCOUNT ACTIVATED',
  'NO OF ZERO BALANCE ACCOUNTS FUNDING',
  'EDD PROGRESS',
  'CKYC PROGRESS',
  'NO OF HOME LOAN',
  'HOME LOAN DISBURSEMENT (AMT IN ACTUALS)',
  'NO OF AUTO LOAN',
  'AUTO LOAN DISBURSEMENT ( AMT IN ACTUALS)',
  'MORTGAGE LOAN NO OF ACCOUNTS',
  'MORTGAGE LOAN DISBURSEMENT(AMT IN ACTUAL)',
  'PERSONAL LOAN NO OF ACCOUNTS',
  'PERSONAL LOAN DISBURSEMENT (AMT IN ACTUALS)',
  'EDUCATION LOAN (AMT IN ACTUALS)',
  'MSME LOAN NO OF ACCOUNTS',
  'MSME DISBURSEMENT (AMT IN ACTUALS)',
  'GOLD LOAN NO OF ACCOUNTS',
  'GOLD LOAN FRESH (AMT IN ACTUALS)',
  'AGRI LOAN NO OF ACCOUNTS',
  'AGRI DISBURSEMENT OTHER THAN GOLD LOAN (AMT IN ACTUALS)',
  'NPA RECOVERY (AMT IN ACTUALS)',
  'NPA UPGRADATIONS (AMT IN ACTUALS)',
  'IFLIC (AMT IN ACTUALS)',
  'NFO/MF (AMT IN ACTUALS)',
  'GENERAL INSURANCE',
  'HEALTH INSURANCE',
  'NO OF GOVT BUSINESS PPF/SUKANYA SAMRUDDHI/NPS/KVP/SCSS ETC ACCOUNTS OPENED',
  'NO OF LEADS GENERATED BY BRANCHES',
  'AMOUNT OF LEADS GENERATED ( IN ACTUALS)',
  'CEMU PROGRESS',
];
const normLabel = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

// Sum every numeric answer across the given reports, indexed by normalised
// label — the question text, a table column, and "question — column" — so a
// form field matches however the questionnaire named it.
function businessTotals(reports) {
  const map = {};
  const add = (label, n) => { const k = normLabel(label); if (!k) return; map[k] = (map[k] || 0) + n; };
  reports.forEach((r) => (r.answers || []).forEach((a) => {
    const v = String(a.value == null ? '' : a.value).trim(); if (!v) return;
    const parts = v.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    let pair = false;
    parts.forEach((p) => { const m = p.match(/^(.+?):\s*(.+)$/); if (m) { const n = toNum(m[2]); if (n != null) { pair = true; add(m[1], n); add(`${a.question} — ${m[1]}`, n); } } });
    if (!pair) { const n = toNum(v); if (n != null) add(a.question, n); }
  }));
  return map;
}
/* ---- Tiny client-side .xlsx (Excel) writer — no libraries ---- */
function crc32(bytes) { let c = ~0; for (let i = 0; i < bytes.length; i++) { c ^= bytes[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; }
function zipStore(files) {
  const enc = (s) => new TextEncoder().encode(s);
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
  const chunks = [], central = []; let offset = 0;
  for (const f of files) {
    const name = enc(f.name), data = f.data, crc = crc32(data);
    const lh = [0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
    const lb = new Uint8Array(lh.length + name.length + data.length); lb.set(lh, 0); lb.set(name, lh.length); lb.set(data, lh.length + name.length); chunks.push(lb);
    const ch = [0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)];
    const cb = new Uint8Array(ch.length + name.length); cb.set(ch, 0); cb.set(name, ch.length); central.push(cb); offset += lb.length;
  }
  const cs = central.reduce((s, c) => s + c.length, 0);
  const eo = [0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cs), ...u32(offset), ...u16(0)];
  const parts = [...chunks, ...central, new Uint8Array(eo)];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let p = 0; for (const pt of parts) { out.set(pt, p); p += pt.length; }
  return out;
}
function colLetter(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = (i - m - 1) / 26; } return s; }
// rows: array of arrays; a numeric cell becomes a real number, everything else text.
function xlsxBlob(rows) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rowsXml = rows.map((row, ri) => `<row r="${ri + 1}">` + row.map((cell, ci) => {
    const ref = colLetter(ci) + (ri + 1);
    if (typeof cell === 'number' && isFinite(cell)) return `<c r="${ref}" t="n"><v>${cell}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(cell == null ? '' : cell)}</t></is></c>`;
  }).join('') + '</row>').join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbr = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const enc = (s) => new TextEncoder().encode(s);
  const bytes = zipStore([
    { name: '[Content_Types].xml', data: enc(ct) }, { name: '_rels/.rels', data: enc(rels) },
    { name: 'xl/workbook.xml', data: enc(wb) }, { name: 'xl/_rels/workbook.xml.rels', data: enc(wbr) },
    { name: 'xl/worksheets/sheet1.xml', data: enc(sheet) },
  ]);
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
function downloadBlob(name, blob) { const u = URL.createObjectURL(blob); const a = el('a', { href: u, download: name }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(u); }
// Share the file via the OS share sheet (so it can be attached in an email /
// messaging app). Falls back to downloading it (+ opening the mail composer).
async function shareOrEmailFile(name, blob, subject, body, forceEmail) {
  try {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: subject, text: body }); return; }
  } catch { return; /* user cancelled */ }
  downloadBlob(name, blob);
  if (forceEmail) window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body + '\n\n(The Excel file has been downloaded — attach it to this email.)')}`;
}
// The editable field list + mapping lives in settings/businessReport. Each
// field is { label, source } where source is the questionnaire question/column
// to sum (blank = match by the field label itself).
async function loadBusinessConfig() {
  try {
    const s = await getDoc(doc(db, 'settings', 'businessReport'));
    if (s.exists() && Array.isArray(s.data().fields) && s.data().fields.length) return s.data().fields;
  } catch { /* ignore */ }
  return BUSINESS_FIELDS.map((l) => ({ label: l, source: '' }));
}
async function saveBusinessConfig(fields) {
  await setDoc(doc(db, 'settings', 'businessReport'), { fields, updatedAt: serverTimestamp(), updatedBy: state.user.uid });
}
// Every numeric question / table column across the questionnaires — offered as
// mapping suggestions so the user maps to real questionnaire data.
function questionnaireSourceLabels(questionnaires) {
  const set = new Set();
  questionnaires.forEach((qn) => (qn.questions || []).forEach((q) => {
    if (q.type === 'number') set.add(q.text);
    else if (q.type === 'table') (q.options || []).forEach((col) => { set.add(col); set.add(`${q.text} — ${col}`); });
  }));
  return [...set].filter(Boolean).sort();
}
function businessMappingModal(fields, sources, onSaved) {
  let rows = fields.map((f) => ({ label: f.label, source: f.source || '' }));
  const dl = el('datalist', { id: 'bizSrc' }, ...sources.map((s) => el('option', { value: s })));
  const listWrap = el('div', {});
  const rowNode = (f) => {
    const name = el('input', { value: f.label || '', placeholder: 'Report field name', oninput: (e) => { f.label = e.target.value; } });
    const src = el('input', { value: f.source || '', placeholder: 'Maps to question / column (blank = by name)', list: 'bizSrc', oninput: (e) => { f.source = e.target.value; } });
    const del = el('button', { type: 'button', class: 'btn danger small', title: 'Remove', onclick: () => { rows = rows.filter((x) => x !== f); rebuild(); } }, '✕');
    return el('div', { class: 'q-row' }, name, src, del);
  };
  function rebuild() { listWrap.innerHTML = ''; rows.forEach((f) => listWrap.append(rowNode(f))); }
  rebuild();
  const content = el('div', {}, dl,
    el('p', { class: 'muted', style: 'font-size:13px' }, 'Left = the field shown in the report. Right = which questionnaire question or table column feeds it (leave blank to match by the field name). Add, remove or rename fields as needed.'),
    listWrap,
    el('div', { class: 'inline', style: 'margin-top:8px' },
      el('button', { type: 'button', class: 'btn', onclick: () => { rows.push({ label: '', source: '' }); rebuild(); } }, '+ Add field'),
      el('button', { type: 'button', class: 'btn ghost', onclick: () => { rows = BUSINESS_FIELDS.map((l) => ({ label: l, source: '' })); rebuild(); } }, 'Reset to form default')));
  modal('Modify report fields & mapping', content, async () => {
    const clean = rows.map((f) => ({ label: (f.label || '').trim(), source: (f.source || '').trim() })).filter((f) => f.label);
    if (!clean.length) throw new Error('Add at least one field.');
    await saveBusinessConfig(clean);
    toast('Mapping saved'); onSaved(clean);
  }, 'Save');
}

async function renderBusinessReport() {
  await withPage(async () => {
    const [reports, departments, questionnaires, config] = await Promise.all([
      listReports().catch(() => []), listDepartments().catch(() => []),
      listQuestionnaires().catch(() => []), loadBusinessConfig(),
    ]);
    let fields = config;
    const sources = questionnaireSourceLabels(questionnaires);
    const canEdit = state.user.role === 'admin' || state.user.role === 'dept_head';
    const head = pageHead('Business Report', canEdit ? [el('button', { class: 'btn', style: 'width:auto', onclick: () => businessMappingModal(fields, sources, (next) => { fields = next; build(); }) }, '✎ Modify')] : []);
    const dateI = el('input', { type: 'date', value: localYmd(), max: localYmd() });
    const deptSel = el('select', {}, el('option', { value: '' }, 'All branches (cumulative)'),
      ...departments.map((d) => el('option', { value: d.id }, d.name)));
    const controls = el('div', { class: 'tile', style: 'margin-bottom:14px' },
      el('div', { class: 'inline' },
        el('label', { style: 'flex:1;margin:0' }, 'Business date', dateI),
        el('label', { style: 'flex:1;margin:0' }, 'Branch / scope', deptSel)));
    const out = el('div', {});

    function build() {
      out.innerHTML = '';
      const d = dateI.value, dep = deptSel.value;
      const rows = reports.filter((r) => subYmd(r) === d && (!dep || (r.deptPath || []).includes(dep)));
      const totals = businessTotals(rows);
      const nStaff = new Set(rows.map((r) => r.userId)).size;
      const lines = fields.map((f) => [f.label, totals[normLabel(f.source || f.label)] ?? 0]);
      const matched = lines.filter(([, v]) => v !== 0).length;
      const scopeName = dep ? ((departments.find((x) => x.id === dep) || {}).name || 'Branch') : 'All branches (cumulative)';
      // Spreadsheet rows (numbers stay numeric); Copy uses the same as TSV.
      const sheetRows = [
        ['Branches daily business report'],
        ['Business date', d], ['Scope', scopeName], ['Reports', `${rows.length} from ${nStaff} staff`],
        [], ['#', 'Metric', 'Cumulative'],
        ...lines.map(([f, v], i) => [i + 1, f, v]),
      ];
      const fileName = `business-report-${d}.xlsx`;
      const subject = 'Branches daily business report — ' + d;
      const body = `${subject} (${scopeName}). ${rows.length} report(s) from ${nStaff} staff.`;
      const makeXlsx = () => xlsxBlob(sheetRows);
      const tsv = sheetRows.map((r) => r.map((c) => (c == null ? '' : String(c))).join('\t')).join('\n');

      out.append(el('div', { class: 'tile', style: 'margin-bottom:12px' },
        el('div', {}, el('strong', {}, `${rows.length} report(s)`), ` from ${nStaff} staff · ${matched}/${fields.length} fields with data`),
        el('div', { class: 'inline', style: 'margin-top:10px;gap:8px;flex-wrap:wrap' },
          el('button', { class: 'btn primary', style: 'width:auto', onclick: () => shareOrEmailFile(fileName, makeXlsx(), subject, body, true) }, '✉ Email (Excel)'),
          el('button', { class: 'btn', style: 'width:auto', onclick: async () => { try { await navigator.clipboard.writeText(tsv); toast('Copied (paste into Excel)'); } catch { toast('Copy failed', true); } } }, '⧉ Copy'),
          el('button', { class: 'btn', style: 'width:auto', onclick: () => downloadBlob(fileName, makeXlsx()) }, '⭳ Download (Excel)'),
          navigator.share ? el('button', { class: 'btn', style: 'width:auto', onclick: () => shareOrEmailFile(fileName, makeXlsx(), subject, body, false) }, '⤴ Share (Excel)') : null)));

      if (!rows.length) { out.append(el('div', { class: 'empty' }, 'No reports for this date and scope yet.')); return; }
      const tb = el('tbody');
      lines.forEach(([f, v], i) => tb.append(el('tr', {}, el('td', {}, String(i + 1)), el('td', {}, f),
        el('td', {}, el('strong', v ? {} : { class: 'muted' }, fmtNum(v))))));
      out.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Metric'), el('th', {}, 'Cumulative'))), tb));
    }
    [dateI, deptSel].forEach((c) => c.addEventListener('change', build));
    build();
    return [head,
      el('p', { class: 'muted', style: 'font-size:13px;margin:0 0 12px' }, 'Cumulative totals of all staff reports for the business date, laid out as the branch daily business report. Pick a branch to get that branch’s figures, or keep “All branches” for the consolidated report. Review, then Email / Copy / Download to send.'),
      controls, out];
  });
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
      el('button', { class: 'btn ghost small', title: 'Edit', onclick: () => editItem(item) }, '✎'),
      el('button', { class: 'btn danger small', title: 'Delete', onclick: () => persist(list.filter((x) => x.id !== item.id), 'Removed') }, '✕'));
  }
  function editItem(item) {
    const title = el('input', { value: item.title || '', required: true });
    const date = el('input', { type: 'date', value: item.date || '' });
    const time = el('input', { type: 'time', value: item.time || '' });
    const prio = el('select', {}, ...['normal', 'high', 'low'].map((p) => el('option', { value: p, selected: (item.priority || 'normal') === p }, p)));
    const note = el('input', { value: item.note || '' });
    modal('Edit scheduled task', el('div', {},
      el('label', {}, 'Task title', title),
      el('div', { class: 'inline' }, el('label', { style: 'flex:1;margin:0' }, 'Date', date), el('label', { style: 'flex:1;margin:0' }, 'Time', time), el('label', { style: 'flex:1;margin:0' }, 'Priority', prio)),
      el('label', { style: 'margin-top:8px' }, 'Note', note)), async () => {
      if (!title.value.trim()) throw new Error('Enter a task title');
      await persist(list.map((x) => x.id === item.id ? { ...x, title: title.value.trim(), date: date.value || '', time: time.value || '', priority: prio.value, note: note.value.trim() } : x), 'Saved');
    }, 'Save');
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

/* ---- Pendency: clear staff-wise and task-wise tracking ---- */
async function loadTaskUpdates() {
  if (state.user.role === 'admin') return getAll('taskUpdates').catch(() => []);
  if (state.user.role === 'dept_head') return getSubtree('taskUpdates').catch(() => []);
  return [];
}

// The last-7-days reporting tracker: chips per day with received/expected, and
// a detail list of who reported / didn't when a day is tapped. A questionnaire
// submission OR a task update on a day both count as "reported".
function dailyReportingSection(tasks, submissions, assignments, users, taskUpdates) {
  const nameById = {};
  users.forEach((u) => { nameById[u.id] = u.name; });
  submissions.forEach((r) => { if (r.userId && !nameById[r.userId]) nameById[r.userId] = r.userName || r.userId; });
  tasks.forEach((t) => { if (t.assignedTo && !nameById[t.assignedTo]) nameById[t.assignedTo] = t.assignedToName || t.assignedTo; });

  const days = [];
  for (let i = 6; i >= 0; i--) days.push(localYmd(new Date(Date.now() - i * 86400000)));
  const reportedByDay = {}; days.forEach((d) => { reportedByDay[d] = new Set(); });
  submissions.forEach((r) => { const d = subYmd(r); if (reportedByDay[d]) reportedByDay[d].add(r.userId); });
  taskUpdates.forEach((u) => { if (reportedByDay[u.date]) reportedByDay[u.date].add(u.userId); });

  // Expected reporters = anyone assigned a questionnaire or a task (plus anyone
  // who actually reported in the window, so nobody is missed).
  const expected = new Map();
  assignments.forEach((a) => { if (a.userId) expected.set(a.userId, nameById[a.userId] || a.userName || a.userId); });
  tasks.forEach((t) => { if (t.assignedTo) expected.set(t.assignedTo, nameById[t.assignedTo] || t.assignedToName || t.assignedTo); });
  Object.values(reportedByDay).forEach((set) => set.forEach((id) => { if (!expected.has(id)) expected.set(id, nameById[id] || id); }));
  const expectedIds = [...expected.keys()];

  const nameOf = (id) => nameById[id] || expected.get(id) || id;
  const fullDay = (ymd) => new Date(ymd + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  const detail = el('div', { class: 'tile', style: 'margin-top:12px' });
  const showDay = (d) => {
    const rec = expectedIds.filter((id) => reportedByDay[d].has(id)).map(nameOf).sort();
    const no = expectedIds.filter((id) => !reportedByDay[d].has(id)).map(nameOf).sort();
    detail.innerHTML = '';
    detail.append(
      el('div', { style: 'font-weight:700;margin-bottom:8px' }, fullDay(d)),
      el('div', { class: 'perf-line perf-excellent' }, el('strong', {}, `✓ Reported (${rec.length}): `), rec.length ? rec.join(', ') : '—'),
      el('div', { class: 'perf-line perf-below', style: 'margin-top:6px' }, el('strong', {}, `✗ Not reported (${no.length}): `), no.length ? no.join(', ') : '—'));
  };

  const chipRow = el('div', { class: 'daychips' });
  const chips = [];
  days.forEach((d) => {
    const rec = expectedIds.filter((id) => reportedByDay[d].has(id)).length;
    const total = expectedIds.length;
    const tier = total === 0 ? '' : rec === total ? 'perf-excellent' : rec === 0 ? 'perf-below' : 'perf-good';
    const dt = new Date(d + 'T00:00:00');
    const chip = el('button', { class: 'daychip ' + tier, onclick: () => { chips.forEach((c) => c.classList.remove('active')); chip.classList.add('active'); showDay(d); } },
      el('div', { style: 'font-size:12px' }, dt.toLocaleDateString(undefined, { weekday: 'short' })),
      el('div', { style: 'font-weight:700' }, dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
      el('div', { style: 'font-size:12px' }, `${rec}/${total}`));
    chips.push(chip); chipRow.append(chip);
  });
  // default to today (last chip)
  if (chips.length) { chips[chips.length - 1].classList.add('active'); showDay(days[days.length - 1]); }

  return [
    el('h3', { style: 'margin:4px 0 8px' }, 'Daily reporting — last 7 days'),
    el('p', { class: 'muted', style: 'margin:0 0 10px;font-size:13px' }, 'Received = the person submitted a report or updated a task that day. Tap a day for who did and didn’t report.'),
    chipRow, detail,
  ];
}

async function renderPendency() {
  await withPage(async () => {
    const [tasks, submissions, assignments, users, taskUpdates] = await Promise.all([
      listTasks(), listReports().catch(() => []), listAssignments().catch(() => []),
      listUsers().catch(() => []), loadTaskUpdates(),
    ]);
    const head = pageHead('Pendency');
    const tracker = dailyReportingSection(tasks, submissions, assignments, users, taskUpdates);
    const pend = tasks.filter((t) => t.type === 'pendency' && t.status !== 'closed');
    if (!pend.length) return [head, ...tracker, el('div', { class: 'empty', style: 'margin-top:20px' }, 'No open quantity tasks yet.')];

    // ----- By staff -----
    const byStaff = new Map();
    pend.forEach((t) => {
      const key = t.assignedTo || t.assignedToName || '—';
      const g = byStaff.get(key) || { name: t.assignedToName || '—', pending: 0, count: 0 };
      g.pending += (t.pendency || 0); g.count += 1;
      byStaff.set(key, g);
    });
    const staffRows = [...byStaff.values()].sort((a, b) => b.pending - a.pending || b.count - a.count);
    const staffBody = el('tbody');
    staffRows.forEach((s) => staffBody.append(el('tr', {},
      el('td', {}, el('strong', {}, s.name)),
      el('td', {}, String(s.count)),
      el('td', {}, el('strong', {}, String(s.pending))))));

    // ----- By task -----  (started, done so far, still pending, last work note)
    const taskBody = el('tbody');
    pend.slice().sort((a, b) => (a.assignedToName || '').localeCompare(b.assignedToName || '') || (b.pendency || 0) - (a.pendency || 0)).forEach((t) => {
      const start = t.initialPendency;
      const now = t.pendency || 0;
      const done = (start != null && start >= now) ? start - now : null; // net completed (blank if more were added)
      const workNote = t.lastRemark ? `${t.lastRemarkDate ? t.lastRemarkDate + ': ' : ''}${t.lastRemark}` : '';
      taskBody.append(el('tr', {},
        el('td', {}, t.assignedToName || ''),
        el('td', {}, el('div', {}, el('strong', {}, t.title), t.dueDate ? el('div', { class: 'muted', style: 'font-size:12px' }, 'due ' + t.dueDate) : null)),
        el('td', {}, start != null ? String(start) : '—'),
        el('td', {}, done != null ? String(done) : '—'),
        el('td', {}, el('strong', {}, String(now))),
        el('td', {}, workNote ? el('span', { class: 'muted' }, workNote) : el('span', { class: 'muted' }, '—')),
        el('td', {}, el('div', { class: 'row-actions' },
          el('button', { class: 'btn ghost small', onclick: () => openTaskUpdate(t) }, 'Update'),
          el('button', { class: 'btn ghost small', onclick: () => taskHistory(t) }, 'History')))));
    });

    return [head,
      ...tracker,
      el('h3', { style: 'margin:24px 0 8px' }, 'By staff'),
      el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Staff'), el('th', {}, 'Open tasks'), el('th', {}, 'Pending'))), staffBody),
      el('h3', { style: 'margin:24px 0 8px' }, 'By task'),
      el('p', { class: 'muted', style: 'margin:0 0 10px;font-size:13px' }, 'Started = original count · Done = net completed so far · Pending = still open. Tap History for the day-by-day log of work done.'),
      el('table', {}, el('thead', {}, el('tr', {},
        el('th', {}, 'Staff'), el('th', {}, 'Task'), el('th', {}, 'Started'), el('th', {}, 'Done'), el('th', {}, 'Pending'), el('th', {}, 'Last work done'), el('th', {}, ''))), taskBody)];
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
  if (t.lastRemark) parts.push(`work ${t.lastRemarkDate ? '(' + t.lastRemarkDate + ')' : ''}: ${t.lastRemark}`);
  if (t.lastTable) parts.push(`table ${t.lastTableDate ? '(' + t.lastTableDate + ')' : ''}: ${t.lastTable.replace(/\n/g, '; ')}`);
  return parts.join(' • ');
}

/** Build the inline update controls for a task. Shared by the reporting flow
 *  (unauthenticated, ctx.uniqueId = entered code) and the dashboard. */
function taskUpdateControls(task, ctx, onDone) {
  const wrap = el('div', {});
  const err = el('div', { class: 'error' });
  // The date this update is FOR (defaults to today, never future). Reporting is
  // attributed to this date, not the day the update happened to be logged.
  const dateI = el('input', { type: 'date', required: true, value: localYmd(), max: localYmd() });
  const dateNode = el('label', {}, 'Date of reporting *', dateI);
  // Optional data table attached to the task (columns defined when assigned).
  const tf = (task.tableColumns && task.tableColumns.length)
    ? tableField(task.tableTitle || 'Details', task.tableColumns, !!task.tableMultiRow) : null;
  const tableNode = tf ? el('label', {}, task.tableTitle || 'Details', tf.node) : null;
  const tableVal = () => (tf ? tf.get() : '');
  if (task.type === 'pendency') {
    const completed = el('input', { type: 'number', min: '0', step: '1', value: '0' });
    const added = el('input', { type: 'number', min: '0', step: '1', value: '0' });
    const workDone = el('textarea', { placeholder: 'What work did you do? (optional)' });
    const btn = el('button', { class: 'btn primary', style: 'width:auto' }, 'Update');
    btn.addEventListener('click', async () => {
      err.textContent = '';
      if (!dateI.value) { err.textContent = 'Please choose the date of reporting.'; return; }
      const c = Math.max(0, parseInt(completed.value || '0', 10) || 0);
      const a = Math.max(0, parseInt(added.value || '0', 10) || 0);
      btn.disabled = true;
      try { await commitTaskUpdate(task, ctx, { completed: c, added: a, workDone: workDone.value.trim(), table: tableVal(), reportDate: dateI.value }); onDone && onDone(); }
      catch (e) { err.textContent = friendlyError(e); btn.disabled = false; }
    });
    wrap.append(
      el('p', {}, 'Currently pending: ', el('strong', {}, String(task.pendency ?? 0))),
      dateNode,
      el('div', { class: 'inline' },
        el('label', { style: 'flex:1' }, 'Completed', completed),
        el('label', { style: 'flex:1' }, 'Newly added', added)),
      tableNode,
      el('label', {}, 'Work done', workDone),
      btn, err);
  } else {
    const grp = 'ot' + task.id;
    const doneR = el('input', { type: 'radio', name: grp, value: 'completed' });
    const pendR = el('input', { type: 'radio', name: grp, value: 'pending', checked: true });
    const workDone = el('textarea', { placeholder: 'What work did you do?' });
    const btn = el('button', { class: 'btn primary', style: 'width:auto' }, 'Update');
    btn.addEventListener('click', async () => {
      err.textContent = '';
      if (!dateI.value) { err.textContent = 'Please choose the date of reporting.'; return; }
      const completed = doneR.checked;
      const note = workDone.value.trim();
      if (!completed && !note) { err.textContent = 'Please describe the work done, or why it is still pending.'; return; }
      btn.disabled = true;
      try { await commitTaskUpdate(task, ctx, { completed, reason: note, workDone: note, table: tableVal(), reportDate: dateI.value }); onDone && onDone(); }
      catch (e) { err.textContent = friendlyError(e); btn.disabled = false; }
    });
    wrap.append(
      dateNode,
      el('div', { class: 'checkbox-list' }, el('label', {}, doneR, ' Completed'), el('label', {}, pendR, ' Still pending')),
      tableNode,
      el('label', {}, 'Work done', workDone), btn, err);
  }
  return wrap;
}

async function commitTaskUpdate(task, ctx, data) {
  // Attribute the update to the chosen reporting date (fallback: today).
  const today = data.reportDate || new Date().toISOString().slice(0, 10);
  const uniqueId = (ctx && ctx.uniqueId) || task.assignedUniqueId;
  const batch = writeBatch(db);
  const taskRef = doc(db, 'tasks', task.id);
  const upRef = doc(colRef('taskUpdates'));
  const workDone = (data.workDone || '').trim();
  const table = (data.table || '').trim();
  // Extra fields written onto the task doc so the latest remark/table show at a
  // glance. Must stay within the fields allowed by progressOnly() in the rules.
  const remarkPatch = {
    ...(workDone ? { lastRemark: workDone, lastRemarkDate: today } : {}),
    ...(table ? { lastTable: table, lastTableDate: today } : {}),
  };
  const withRemark = (obj) => ({ ...obj, ...(workDone ? { workDone } : {}), ...(table ? { table } : {}) });
  const base = {
    taskId: task.id, userId: task.assignedTo, uniqueId, departmentId: task.departmentId ?? null,
    deptPath: task.deptPath ?? [], type: task.type, date: today, createdAt: serverTimestamp(),
  };
  // Completing a task no longer closes it directly — it waits for a manager to
  // approve (which removes it). Only completion needs approval; ordinary
  // progress keeps the task open.
  let completing = false;
  if (task.type === 'pendency') {
    const before = task.pendency ?? 0;
    const after = before - data.completed + data.added;
    completing = after <= 0;
    const newStatus = completing ? 'awaiting_approval' : 'open';
    batch.update(taskRef, { pendency: after, status: newStatus, updatedAt: serverTimestamp(), ...remarkPatch });
    batch.set(upRef, withRemark({ ...base, completed: data.completed, added: data.added, before, after }));
    task.pendency = after; task.status = newStatus;
  } else if (data.completed) {
    completing = true;
    batch.update(taskRef, { oneTimeStatus: 'completed', completedDate: today, status: 'awaiting_approval', updatedAt: serverTimestamp(), ...remarkPatch });
    batch.set(upRef, withRemark({ ...base, action: 'completed', completedDate: today }));
    task.oneTimeStatus = 'completed'; task.status = 'awaiting_approval';
  } else {
    batch.update(taskRef, { pendingReason: data.reason, updatedAt: serverTimestamp(), ...remarkPatch });
    batch.set(upRef, withRemark({ ...base, action: 'pending', reason: data.reason }));
    task.pendingReason = data.reason;
  }
  Object.assign(task, remarkPatch); // reflect latest remark/table locally for re-render
  await batch.commit();
  toast(completing ? 'Marked complete — sent for approval' : 'Task updated');
}

async function renderTasks() {
  await withPage(async () => {
    const canAssign = state.user.role === 'admin' || state.user.role === 'dept_head';
    const [tasks, users] = await Promise.all([listTasks(), canAssign ? listUsers() : Promise.resolve([])]);
    const isEmployee = state.user.role === 'employee';
    const actions = canAssign ? [el('button', { class: 'btn primary', style: 'width:auto', onclick: () => taskModal(users) }, '+ Assign task')] : [];
    const head = pageHead(isEmployee ? 'My Tasks' : 'Tasks', actions);
    if (!tasks.length) return [head, el('div', { class: 'empty' }, 'No tasks.')];
    // Tasks awaiting a completion approval float to the top for managers.
    const ordered = tasks.slice().sort((a, b) => (b.status === 'awaiting_approval') - (a.status === 'awaiting_approval'));
    const tbody = el('tbody');
    ordered.forEach((t) => {
      const awaiting = t.status === 'awaiting_approval';
      const progress = t.type === 'pendency'
        ? el('span', {}, `pending ${t.pendency ?? 0}` + (t.initialPendency != null ? ` / start ${t.initialPendency}` : ''))
        : el('span', { class: 'pill ' + (t.oneTimeStatus === 'completed' ? 'done' : 'pending') }, t.oneTimeStatus || 'pending');
      const statusPill = awaiting ? el('span', { class: 'pill in_progress' }, 'awaiting approval')
        : el('span', { class: 'pill ' + (t.status === 'closed' ? 'done' : 'pending') }, t.status || 'open');
      tbody.append(el('tr', {},
        el('td', {}, el('div', {}, el('strong', {}, t.title), t.description ? el('div', { class: 'muted' }, t.description) : null,
          el('div', { class: 'muted', style: 'font-size:12px' }, taskMeta(t)))),
        el('td', {}, t.assignedToName || ''),
        el('td', {}, t.type === 'pendency' ? 'quantity' : 'one-time'),
        el('td', {}, progress),
        el('td', {}, statusPill),
        el('td', {}, el('div', { class: 'row-actions' },
          (canAssign && awaiting) ? el('button', { class: 'btn small', style: 'background:#dcfce7;color:#15803d', onclick: () => approveTaskCompletion(t) }, '✓ Approve') : null,
          (canAssign && awaiting) ? el('button', { class: 'btn ghost small', onclick: () => reopenTask(t) }, 'Reopen') : null,
          (t.status !== 'closed' && !awaiting) ? el('button', { class: 'btn ghost small', onclick: () => openTaskUpdate(t) }, 'Update') : null,
          canAssign ? el('button', { class: 'btn ghost small', onclick: () => taskEditModal(t) }, 'Edit') : null,
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
    let line = u.type === 'pendency'
      ? `${when}: completed ${u.completed}, added ${u.added} → pending ${u.after}`
      : `${when}: ${u.action}${u.reason ? ' — ' + u.reason : ''}${u.completedDate ? ' (' + u.completedDate + ')' : ''}`;
    // Show the work-done remark when it isn't already the pending reason.
    if (u.workDone && u.workDone !== u.reason) line += ` — work: ${u.workDone}`;
    if (u.table) line += ` — table: ${u.table.replace(/\n/g, '; ')}`;
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
  const tableTitle = el('input', { placeholder: 'Table heading, e.g. Leads' });
  const tableCols = el('input', { placeholder: 'Columns, comma separated, e.g. Number, Amount' });
  const tableMulti = el('input', { type: 'checkbox' });
  modal('Assign task', el('div', {},
    el('label', {}, 'Title', title), el('label', {}, 'Description', desc),
    el('label', {}, 'Assign to', assignee),
    el('label', {}, 'Type', type),
    el('label', {}, 'Horizon in days (optional)', horizon),
    pendLabel,
    el('p', { class: 'muted', style: 'font-size:13px;margin-bottom:2px' }, 'Optional data table the person fills in when updating this task:'),
    el('div', { class: 'inline' }, el('label', { style: 'flex:1' }, 'Table heading', tableTitle), el('label', { style: 'flex:2' }, 'Table columns', tableCols)),
    el('label', { style: 'font-weight:400' }, tableMulti, ' allow adding rows'),
    el('p', { class: 'muted', style: 'font-size:13px' }, 'The person updates this task by entering their Unique ID to report, or from their dashboard if they have a login.')), async () => {
    if (!assignee.value) throw new Error('Choose an assignee');
    const u = users.find((x) => x.id === assignee.value);
    if (!u.uniqueId) throw new Error('That user has no Unique ID.');
    const t = type.value;
    const horizonDays = horizon.value ? parseInt(horizon.value, 10) : null;
    const dueDate = horizonDays ? addDays(horizonDays) : null;
    let pendency = null;
    if (t === 'pendency') { pendency = parseInt(pend.value || '0', 10); if (!(pendency > 0)) throw new Error('Enter a starting pending count greater than 0.'); }
    const tableColumns = tableCols.value.split(',').map((s) => s.trim()).filter(Boolean);
    const taskRef = doc(colRef('tasks'));
    const batch = writeBatch(db);
    batch.set(taskRef, {
      title: title.value.trim(), description: desc.value.trim(),
      assignedTo: u.id, assignedToName: u.name, assignedUniqueId: u.uniqueId, assignedBy: state.user.uid,
      departmentId: u.departmentId ?? null, deptPath: u.deptPath || [], type: t, horizonDays, dueDate, status: 'open',
      oneTimeStatus: t === 'onetime' ? 'pending' : null, pendingReason: null, completedDate: null,
      pendency: t === 'pendency' ? pendency : null, initialPendency: t === 'pendency' ? pendency : null,
      tableColumns, tableTitle: tableColumns.length ? (tableTitle.value.trim() || 'Details') : null, tableMultiRow: tableColumns.length ? tableMulti.checked : false,
      createdAt: serverTimestamp(),
    });
    batch.update(doc(db, 'codes', u.uniqueId), { tasks: arrayUnion(taskRef.id) });
    if (u.authUid) batch.set(doc(colRef('notifications')), { userId: u.id, message: `New task assigned: "${title.value.trim()}"`, type: 'task', relatedId: taskRef.id, isRead: false, createdAt: serverTimestamp() });
    await batch.commit(); toast('Task assigned'); renderTasks();
  }, 'Assign');
}

function taskEditModal(t) {
  const title = el('input', { value: t.title || '', required: true });
  const desc = el('textarea', {}, t.description || '');
  const due = el('input', { type: 'date', value: t.dueDate || '' });
  const pend = el('input', { type: 'number', min: '0', step: '1', value: String(t.pendency ?? 0) });
  const tableTitle = el('input', { placeholder: 'Table heading, e.g. Leads', value: t.tableTitle || '' });
  const tableCols = el('input', { placeholder: 'Columns, comma separated, e.g. Number, Amount', value: (t.tableColumns || []).join(', ') });
  const tableMulti = el('input', { type: 'checkbox', ...(t.tableMultiRow ? { checked: true } : {}) });
  modal('Edit task', el('div', {},
    el('label', {}, 'Title', title),
    el('label', {}, 'Description', desc),
    el('label', {}, 'Due date', due),
    t.type === 'pendency' ? el('label', {}, 'Current pending count', pend) : null,
    el('p', { class: 'muted', style: 'font-size:13px;margin-bottom:2px' }, 'Optional data table the person fills in when updating this task:'),
    el('div', { class: 'inline' }, el('label', { style: 'flex:1' }, 'Table heading', tableTitle), el('label', { style: 'flex:2' }, 'Table columns', tableCols)),
    el('label', { style: 'font-weight:400' }, tableMulti, ' allow adding rows')),
    async () => {
      const tableColumns = tableCols.value.split(',').map((s) => s.trim()).filter(Boolean);
      const patch = { title: title.value.trim(), description: desc.value.trim(), dueDate: due.value || null,
        tableColumns, tableTitle: tableColumns.length ? (tableTitle.value.trim() || 'Details') : null, tableMultiRow: tableColumns.length ? tableMulti.checked : false,
        updatedAt: serverTimestamp() };
      if (t.type === 'pendency') {
        const p = Math.max(0, parseInt(pend.value || '0', 10) || 0);
        patch.pendency = p;
        patch.status = p <= 0 ? 'closed' : 'open';
      }
      await updateDoc(doc(db, 'tasks', t.id), patch);
      toast('Task updated'); renderTasks();
    }, 'Save changes');
}

async function delTask(t) {
  if (!confirm(`Delete task "${t.title}"?`)) return;
  const batch = writeBatch(db);
  batch.delete(doc(db, 'tasks', t.id));
  if (t.assignedUniqueId) batch.update(doc(db, 'codes', t.assignedUniqueId), { tasks: arrayRemove(t.id) });
  await batch.commit();
  toast('Task deleted'); renderTasks();
}

// Approve a completed task: it is removed (and detached from the person's code).
async function approveTaskCompletion(t) {
  if (!confirm(`Approve completion of "${t.title}"? It will be removed from the list.`)) return;
  const batch = writeBatch(db);
  batch.delete(doc(db, 'tasks', t.id));
  if (t.assignedUniqueId) batch.update(doc(db, 'codes', t.assignedUniqueId), { tasks: arrayRemove(t.id) });
  try { await batch.commit(); toast('Approved and removed'); renderTasks(); }
  catch (e) { toast(friendlyError(e), true); }
}
// Reject a completion: send the task back to the employee as open.
async function reopenTask(t) {
  const patch = { status: 'open', updatedAt: serverTimestamp() };
  if (t.type === 'onetime') { patch.oneTimeStatus = 'pending'; patch.completedDate = null; }
  try { await updateDoc(doc(db, 'tasks', t.id), patch); toast('Sent back to the employee'); renderTasks(); }
  catch (e) { toast(friendlyError(e), true); }
}

/* ------------------------------------------------------------------ */
boot();
