'use strict';

/* ------------------------------------------------------------------ *
 * State & helpers
 * ------------------------------------------------------------------ */
const state = {
  token: localStorage.getItem('token') || null,
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  page: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && auth) {
    logout();
    throw new Error('Session expired, please sign in again.');
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}
function safeJson(t) { try { return JSON.parse(t); } catch { return t; } }

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  setTimeout(() => t.classList.add('hidden'), 3200);
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? s : d.toLocaleString();
}

/* ------------------------------------------------------------------ *
 * View switching
 * ------------------------------------------------------------------ */
function show(viewId) {
  ['view-code', 'view-login', 'view-app'].forEach((v) =>
    $('#' + v).classList.toggle('hidden', v !== viewId));
}

function boot() {
  wirePublic();
  if (state.token && state.user) {
    enterApp();
  } else {
    show('view-code');
  }
}

/* ------------------------------------------------------------------ *
 * Public "report with a code" flow
 * ------------------------------------------------------------------ */
function wirePublic() {
  $('#to-login').addEventListener('click', (e) => { e.preventDefault(); show('view-login'); });
  $('#to-code').addEventListener('click', (e) => { e.preventDefault(); show('view-code'); });

  $('#code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#code-error').textContent = '';
    const code = $('#code-input').value.trim();
    if (!code) return;
    try {
      const data = await api('/report/lookup', { method: 'POST', body: { code }, auth: false });
      renderQuestionnaire(code, data);
    } catch (err) {
      $('#code-error').textContent = err.message;
      $('#questionnaire-container').innerHTML = '';
    }
  });

  $('#login-form').addEventListener('submit', doLogin);
}

function renderQuestionnaire(code, data) {
  const container = $('#questionnaire-container');
  container.innerHTML = '';
  const form = el('form', { class: 'qn-form' });
  form.append(
    el('hr'),
    el('p', {}, el('strong', {}, `Hello, ${data.employee_name}`)),
    el('h2', {}, data.title),
    data.description ? el('p', { class: 'muted' }, data.description) : null,
    data.previous_submissions ? el('p', { class: 'muted' }, `You have submitted this ${data.previous_submissions} time(s) before.`) : null,
  );

  const inputs = [];
  data.questions.forEach((q) => {
    const { node, get } = fieldFor(q);
    form.append(node);
    inputs.push({ q, get });
  });

  const errBox = el('div', { class: 'error' });
  const submitBtn = el('button', { type: 'submit', class: 'btn primary' }, 'Submit report');
  form.append(errBox, submitBtn);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.textContent = '';
    const answers = inputs.map(({ q, get }) => ({ question_id: q.id, value: get() }));
    submitBtn.disabled = true;
    try {
      await api('/report/submit', { method: 'POST', body: { code, answers }, auth: false });
      container.innerHTML = '';
      container.append(
        el('div', { class: 'card', style: 'text-align:center' },
          el('h2', {}, '✓ Report submitted'),
          el('p', { class: 'muted' }, 'Thank you. Your report has been recorded.'),
          el('button', { class: 'btn', onclick: () => { $('#code-input').value = ''; container.innerHTML = ''; } }, 'Submit another'))
      );
    } catch (err) {
      errBox.textContent = err.message;
      submitBtn.disabled = false;
    }
  });

  container.append(form);
}

/** Build a labelled input for a question; returns { node, get } */
function fieldFor(q, prefix = 'q') {
  const id = `${prefix}_${q.id}`;
  const label = el('label', {}, q.text + (q.required ? ' *' : ''));
  let getter;

  if (q.type === 'textarea') {
    const input = el('textarea', { id, required: q.required });
    label.append(input);
    getter = () => input.value;
  } else if (q.type === 'number') {
    const input = el('input', { id, type: 'number', step: 'any', required: q.required });
    label.append(input);
    getter = () => input.value;
  } else if (q.type === 'date') {
    const input = el('input', { id, type: 'date', required: q.required });
    label.append(input);
    getter = () => input.value;
  } else if (q.type === 'select') {
    const sel = el('select', { id, required: q.required },
      el('option', { value: '' }, '— choose —'),
      ...(q.options || []).map((o) => el('option', { value: o }, o)));
    label.append(sel);
    getter = () => sel.value;
  } else if (q.type === 'radio') {
    const wrap = el('div', { class: 'checkbox-list' });
    (q.options || []).forEach((o, i) => {
      wrap.append(el('label', {},
        el('input', { type: 'radio', name: id, value: o, required: q.required && i === 0 }), o));
    });
    label.append(wrap);
    getter = () => (wrap.querySelector('input:checked') || {}).value || '';
  } else if (q.type === 'checkbox') {
    const wrap = el('div', { class: 'checkbox-list' });
    (q.options || []).forEach((o) => {
      wrap.append(el('label', {}, el('input', { type: 'checkbox', value: o }), o));
    });
    label.append(wrap);
    getter = () => Array.from(wrap.querySelectorAll('input:checked')).map((c) => c.value);
  } else {
    const input = el('input', { id, type: 'text', required: q.required });
    label.append(input);
    getter = () => input.value;
  }
  return { node: label, get: getter };
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
async function doLogin(e) {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      auth: false,
      body: { email: $('#login-email').value, password: $('#login-password').value },
    });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    enterApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  show('view-code');
}

/* ------------------------------------------------------------------ *
 * App shell
 * ------------------------------------------------------------------ */
const PAGES = {
  admin: ['dashboard', 'departments', 'users', 'questionnaires', 'reports', 'tasks'],
  dept_head: ['dashboard', 'team', 'questionnaires', 'reports', 'tasks'],
  employee: ['tasks', 'reports'],
};
const PAGE_LABELS = {
  dashboard: 'Dashboard', departments: 'Departments', users: 'Users', team: 'My Team',
  questionnaires: 'Questionnaires', reports: 'Reports', tasks: 'Tasks',
};

function enterApp() {
  show('view-app');
  $('#user-label').textContent = `${state.user.name} · ${state.user.role.replace('_', ' ')}`;
  $('#logout').onclick = logout;
  $('#bell').onclick = toggleNotifications;

  const nav = $('#nav');
  nav.innerHTML = '';
  const pages = PAGES[state.user.role] || ['reports'];
  pages.forEach((p) => {
    nav.append(el('button', { class: 'nav-item', 'data-page': p, onclick: () => navigate(p) },
      state.user.role === 'employee' && p === 'reports' ? 'My Reports'
        : state.user.role === 'employee' && p === 'tasks' ? 'My Tasks'
        : PAGE_LABELS[p]));
  });
  navigate(pages[0]);
  refreshNotifications();
  setInterval(refreshNotifications, 30000);
}

function navigate(page) {
  state.page = page;
  document.querySelectorAll('.nav-item').forEach((n) =>
    n.classList.toggle('active', n.dataset.page === page));
  $('#notif-panel').classList.add('hidden');
  const render = ROUTES[page];
  if (render) render();
}

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */
async function refreshNotifications() {
  try {
    const { notifications, unread } = await api('/notifications');
    const badge = $('#bell-count');
    badge.textContent = unread;
    badge.classList.toggle('hidden', unread === 0);
    state._notifications = notifications;
  } catch { /* ignore */ }
}

function toggleNotifications() {
  const panel = $('#notif-panel');
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  const items = state._notifications || [];
  panel.innerHTML = '';
  panel.append(el('div', { class: 'notif-head' },
    el('strong', {}, 'Notifications'),
    el('button', { class: 'btn ghost small', onclick: markAllRead }, 'Mark all read')));
  if (items.length === 0) {
    panel.append(el('div', { class: 'notif-item muted' }, 'No notifications yet.'));
  } else {
    items.forEach((n) => panel.append(
      el('div', { class: 'notif-item' + (n.is_read ? '' : ' unread') },
        el('div', {}, n.message),
        el('div', { class: 'time' }, fmtDate(n.created_at)))));
  }
  panel.classList.remove('hidden');
}

async function markAllRead() {
  await api('/notifications/read-all', { method: 'POST' });
  await refreshNotifications();
  toggleNotifications();
}

/* ------------------------------------------------------------------ *
 * Modal helper
 * ------------------------------------------------------------------ */
function modal(title, contentNode, onSubmit, submitLabel = 'Save') {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const form = el('form', { class: 'modal' });
  const err = el('div', { class: 'error' });
  form.append(el('h3', {}, title), contentNode, err,
    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'btn ghost', onclick: () => backdrop.remove() }, 'Cancel'),
      el('button', { type: 'submit', class: 'btn primary', style: 'width:auto' }, submitLabel)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try { await onSubmit(); backdrop.remove(); }
    catch (ex) { err.textContent = ex.message; }
  });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  form.addEventListener('click', (e) => e.stopPropagation());
  backdrop.append(form);
  document.body.append(backdrop);
  return backdrop;
}

function pageHead(title, actions = []) {
  return el('div', { class: 'page-head' }, el('h2', {}, title), el('div', { class: 'inline' }, ...actions));
}

/* ------------------------------------------------------------------ *
 * Pages
 * ------------------------------------------------------------------ */
const ROUTES = {
  dashboard: renderDashboard,
  departments: renderDepartments,
  users: () => renderUsers(false),
  team: () => renderUsers(true),
  questionnaires: renderQuestionnaires,
  reports: renderReports,
  tasks: renderTasks,
};

async function renderDashboard() {
  const page = $('#page');
  page.innerHTML = 'Loading…';
  const [users, reports, tasks] = await Promise.all([
    state.user.role === 'admin' || state.user.role === 'dept_head' ? api('/users').catch(() => []) : [],
    api('/reports').catch(() => []),
    api('/tasks').catch(() => []),
  ]);
  page.innerHTML = '';
  page.append(pageHead(`Welcome, ${state.user.name}`));
  const openTasks = tasks.filter((t) => t.status !== 'done').length;
  page.append(el('div', { class: 'grid' },
    tile('Reports', reports.length, 'submitted'),
    tile('Open tasks', openTasks, `of ${tasks.length} total`),
    (users.length ? tile('People', users.length, 'in view') : null),
  ));
  page.append(el('h3', { style: 'margin-top:28px' }, 'Recent reports'));
  page.append(reportsTable(reports.slice(0, 8)));
}

function tile(title, big, sub) {
  return el('div', { class: 'tile' }, el('h3', {}, title), el('div', { class: 'big' }, big),
    el('div', { class: 'muted' }, sub));
}

/* ---- Departments (admin) ---- */
async function renderDepartments() {
  const page = $('#page');
  page.innerHTML = 'Loading…';
  const [departments, users] = await Promise.all([api('/departments'), api('/users').catch(() => [])]);
  page.innerHTML = '';
  page.append(pageHead('Departments', [
    el('button', { class: 'btn primary', style: 'width:auto', onclick: () => departmentModal(null, users) }, '+ New department'),
  ]));
  if (!departments.length) { page.append(el('div', { class: 'empty' }, 'No departments yet.')); return; }
  const table = el('table', {}, el('thead', {}, el('tr', {},
    el('th', {}, 'Name'), el('th', {}, 'Head'), el('th', {}, 'Members'), el('th', {}, ''))));
  const tbody = el('tbody');
  departments.forEach((d) => tbody.append(el('tr', {},
    el('td', {}, d.name),
    el('td', {}, d.head_name || '—'),
    el('td', {}, String(d.member_count)),
    el('td', {}, el('div', { class: 'row-actions' },
      el('button', { class: 'btn ghost small', onclick: () => departmentModal(d, users) }, 'Edit'),
      el('button', { class: 'btn danger small', onclick: () => delDepartment(d) }, 'Delete'))))));
  table.append(tbody);
  page.append(table);
}

function departmentModal(dept, users) {
  const name = el('input', { value: dept ? dept.name : '', required: true });
  const head = el('select', {}, el('option', { value: '' }, '— none —'),
    ...users.map((u) => el('option', { value: u.id, selected: dept && dept.head_user_id === u.id }, `${u.name} (${u.email})`)));
  const content = el('div', {}, el('label', {}, 'Name', name), el('label', {}, 'Department head', head));
  modal(dept ? 'Edit department' : 'New department', content, async () => {
    const body = { name: name.value.trim(), head_user_id: head.value ? Number(head.value) : null };
    if (dept) await api(`/departments/${dept.id}`, { method: 'PUT', body });
    else await api('/departments', { method: 'POST', body });
    toast('Department saved');
    renderDepartments();
  });
}

async function delDepartment(d) {
  if (!confirm(`Delete department "${d.name}"? Members will be unassigned.`)) return;
  await api(`/departments/${d.id}`, { method: 'DELETE' });
  toast('Department deleted');
  renderDepartments();
}

/* ---- Users / Team ---- */
async function renderUsers(teamOnly) {
  const page = $('#page');
  page.innerHTML = 'Loading…';
  const [users, departments] = await Promise.all([api('/users'), api('/departments').catch(() => [])]);
  page.innerHTML = '';
  page.append(pageHead(teamOnly ? 'My Team' : 'Users', [
    el('button', { class: 'btn primary', style: 'width:auto', onclick: () => userModal(null, departments) }, '+ Add user'),
  ]));
  const table = el('table', {}, el('thead', {}, el('tr', {},
    el('th', {}, 'Name'), el('th', {}, 'Email'), el('th', {}, 'Role'), el('th', {}, 'Department'),
    state.user.role === 'admin' ? el('th', {}, '') : null)));
  const tbody = el('tbody');
  users.forEach((u) => tbody.append(el('tr', {},
    el('td', {}, u.name),
    el('td', {}, u.email),
    el('td', {}, el('span', { class: 'pill ' + u.role }, u.role.replace('_', ' '))),
    el('td', {}, u.department_name || '—'),
    state.user.role === 'admin' ? el('td', {}, el('div', { class: 'row-actions' },
      el('button', { class: 'btn ghost small', onclick: () => userModal(u, departments) }, 'Edit'),
      u.id !== state.user.id ? el('button', { class: 'btn danger small', onclick: () => delUser(u) }, 'Delete') : null)) : null)));
  table.append(tbody);
  page.append(table);
}

function userModal(user, departments) {
  const name = el('input', { value: user ? user.name : '', required: true });
  const email = el('input', { type: 'email', value: user ? user.email : '', required: true });
  const password = el('input', { type: 'password', placeholder: user ? 'Leave blank to keep' : '' });
  const isAdmin = state.user.role === 'admin';
  const role = el('select', {},
    ...['employee', 'dept_head', 'admin'].map((r) =>
      el('option', { value: r, selected: user && user.role === r }, r.replace('_', ' '))));
  const dept = el('select', {}, el('option', { value: '' }, '— none —'),
    ...departments.map((d) => el('option', { value: d.id, selected: user && user.department_id === d.id }, d.name)));
  const content = el('div', {},
    el('label', {}, 'Name', name),
    el('label', {}, 'Email', email),
    el('label', {}, user ? 'New password' : 'Password', password),
    isAdmin ? el('label', {}, 'Role', role) : null,
    isAdmin ? el('label', {}, 'Department', dept) : null);
  modal(user ? 'Edit user' : 'Add user', content, async () => {
    const body = { name: name.value.trim(), email: email.value.trim() };
    if (password.value) body.password = password.value;
    if (isAdmin) { body.role = role.value; body.department_id = dept.value ? Number(dept.value) : null; }
    if (user) await api(`/users/${user.id}`, { method: 'PUT', body });
    else {
      if (!body.password) throw new Error('Password is required for new users');
      await api('/users', { method: 'POST', body });
    }
    toast('User saved');
    navigate(state.page);
  });
}

async function delUser(u) {
  if (!confirm(`Delete user "${u.name}"? Their reports and tasks will also be removed.`)) return;
  await api(`/users/${u.id}`, { method: 'DELETE' });
  toast('User deleted');
  navigate(state.page);
}

/* ---- Questionnaires ---- */
async function renderQuestionnaires() {
  const page = $('#page');
  page.innerHTML = 'Loading…';
  const list = await api('/questionnaires');
  page.innerHTML = '';
  page.append(pageHead('Questionnaires', [
    el('button', { class: 'btn primary', style: 'width:auto', onclick: () => questionnaireModal(null) }, '+ New questionnaire'),
  ]));
  if (!list.length) { page.append(el('div', { class: 'empty' }, 'No questionnaires yet. Create one to start collecting reports.')); return; }
  const table = el('table', {}, el('thead', {}, el('tr', {},
    el('th', {}, 'Title'), el('th', {}, 'Questions'), el('th', {}, 'Assigned'), el('th', {}, 'Status'), el('th', {}, ''))));
  const tbody = el('tbody');
  list.forEach((q) => tbody.append(el('tr', {},
    el('td', {}, q.title),
    el('td', {}, String(q.question_count)),
    el('td', {}, String(q.assignment_count)),
    el('td', {}, el('span', { class: 'pill ' + (q.active ? 'done' : 'pending') }, q.active ? 'active' : 'inactive')),
    el('td', {}, el('div', { class: 'row-actions' },
      el('button', { class: 'btn ghost small', onclick: () => manageAssignments(q) }, 'Assign & codes'),
      el('button', { class: 'btn ghost small', onclick: () => questionnaireModal(q.id) }, 'Edit'),
      el('button', { class: 'btn danger small', onclick: () => delQuestionnaire(q) }, 'Delete'))))));
  table.append(tbody);
  page.append(table);
}

const Q_TYPES = [
  ['text', 'Short text'], ['textarea', 'Long text'], ['number', 'Number'],
  ['date', 'Date'], ['select', 'Dropdown'], ['radio', 'Single choice'], ['checkbox', 'Multiple choice'],
];

async function questionnaireModal(id) {
  let existing = null;
  if (id) existing = await api(`/questionnaires/${id}`);
  const title = el('input', { value: existing ? existing.title : '', required: true });
  const desc = el('textarea', {}, existing ? existing.description || '' : '');
  const qWrap = el('div', {});

  const addQuestion = (q = {}) => {
    const item = el('div', { class: 'q-builder-item' });
    const text = el('input', { placeholder: 'Question text', value: q.text || '' });
    const type = el('select', {}, ...Q_TYPES.map(([v, l]) => el('option', { value: v, selected: q.type === v }, l)));
    const required = el('input', { type: 'checkbox', ...(q.required ? { checked: true } : {}) });
    const options = el('input', { placeholder: 'Options (comma separated)', value: (q.options || []).join(', ') });
    const toggleOptions = () => { options.style.display = ['select', 'radio', 'checkbox'].includes(type.value) ? '' : 'none'; };
    type.addEventListener('change', toggleOptions);
    item.append(
      el('div', { class: 'q-row' }, text,
        el('button', { type: 'button', class: 'btn danger small', onclick: () => item.remove() }, '✕')),
      el('div', { class: 'q-row' }, type, el('label', { style: 'margin:0;font-weight:400' }, required, ' required')),
      options);
    toggleOptions();
    item._get = () => ({
      text: text.value.trim(),
      type: type.value,
      required: required.checked,
      options: options.value.split(',').map((s) => s.trim()).filter(Boolean),
    });
    qWrap.append(item);
  };

  (existing ? existing.questions : [{}]).forEach(addQuestion);

  const content = el('div', {},
    el('label', {}, 'Title', title),
    el('label', {}, 'Description', desc),
    el('label', {}, 'Questions'), qWrap,
    el('button', { type: 'button', class: 'btn', onclick: () => addQuestion() }, '+ Add question'));

  modal(existing ? 'Edit questionnaire' : 'New questionnaire', content, async () => {
    const questions = Array.from(qWrap.querySelectorAll('.q-builder-item'))
      .map((n) => n._get()).filter((q) => q.text);
    if (!questions.length) throw new Error('Add at least one question');
    const body = { title: title.value.trim(), description: desc.value.trim(), questions };
    if (existing) await api(`/questionnaires/${existing.id}`, { method: 'PUT', body });
    else await api('/questionnaires', { method: 'POST', body });
    toast('Questionnaire saved');
    renderQuestionnaires();
  }, existing ? 'Save changes' : 'Create');
}

async function delQuestionnaire(q) {
  if (!confirm(`Delete "${q.title}" and all its reports?`)) return;
  await api(`/questionnaires/${q.id}`, { method: 'DELETE' });
  toast('Questionnaire deleted');
  renderQuestionnaires();
}

async function manageAssignments(q) {
  const [assignments, users] = await Promise.all([
    api(`/assignments?questionnaire_id=${q.id}`),
    api('/users'),
  ]);
  const assignedIds = new Set(assignments.map((a) => a.user_id));
  const available = users.filter((u) => !assignedIds.has(u.id));

  const userSelect = el('select', {},
    el('option', { value: '' }, available.length ? '— choose employee —' : 'Everyone is already assigned'),
    ...available.map((u) => el('option', { value: u.id }, `${u.name} (${u.email})`)));

  const list = el('div', {});
  const renderList = (rows) => {
    list.innerHTML = '';
    if (!rows.length) { list.append(el('p', { class: 'muted' }, 'No one assigned yet.')); return; }
    const table = el('table', {}, el('thead', {}, el('tr', {},
      el('th', {}, 'Employee'), el('th', {}, 'Code'), el('th', {}, 'Reports'), el('th', {}, ''))));
    const tbody = el('tbody');
    rows.forEach((a) => tbody.append(el('tr', {},
      el('td', {}, a.user_name),
      el('td', {}, el('span', { class: 'code-chip' }, a.code)),
      el('td', {}, String(a.submission_count)),
      el('td', {}, el('div', { class: 'row-actions' },
        el('button', { class: 'btn ghost small', onclick: () => copyCode(a.code) }, 'Copy'),
        el('button', { class: 'btn ghost small', onclick: () => regen(a) }, 'New code'),
        el('button', { class: 'btn danger small', onclick: () => unassign(a) }, 'Remove'))))));
    table.append(tbody);
    list.append(table);
  };
  renderList(assignments);

  async function refresh() {
    const rows = await api(`/assignments?questionnaire_id=${q.id}`);
    renderList(rows);
  }
  async function regen(a) { await api(`/assignments/${a.id}/regenerate`, { method: 'POST' }); toast('New code issued'); refresh(); }
  async function unassign(a) {
    if (!confirm(`Remove ${a.user_name}'s assignment?`)) return;
    await api(`/assignments/${a.id}`, { method: 'DELETE' }); toast('Removed'); refresh();
  }

  const content = el('div', {},
    el('p', { class: 'muted' }, `Assign "${q.title}" to employees. Each gets a unique code to open their report.`),
    el('div', { class: 'inline' }, userSelect,
      el('button', { type: 'button', class: 'btn primary', style: 'width:auto',
        onclick: async () => {
          if (!userSelect.value) return;
          await api('/assignments', { method: 'POST', body: { questionnaire_id: q.id, user_ids: [Number(userSelect.value)] } });
          toast('Assigned'); manageAssignmentsClose(); manageAssignments(q);
        } }, 'Assign')),
    el('hr'), list);

  const backdrop = modal(`Assignments · ${q.title}`, content, async () => {}, 'Done');
  // Replace the default submit (Save) behaviour: just close.
  backdrop.querySelector('.modal-actions').innerHTML = '';
  backdrop.querySelector('.modal-actions').append(
    el('button', { type: 'button', class: 'btn primary', style: 'width:auto', onclick: () => backdrop.remove() }, 'Done'));
  window._closeAssign = () => backdrop.remove();
}
function manageAssignmentsClose() { if (window._closeAssign) window._closeAssign(); }

function copyCode(code) {
  navigator.clipboard?.writeText(code).then(() => toast(`Copied ${code}`), () => toast(code));
}

/* ---- Reports ---- */
async function renderReports() {
  const page = $('#page');
  page.innerHTML = 'Loading…';
  const reports = await api('/reports');
  page.innerHTML = '';
  const isEmployee = state.user.role === 'employee';
  const actions = [];
  if (!isEmployee) {
    actions.push(el('a', { class: 'btn', style: 'width:auto',
      href: `/api/reports/export/csv`, onclick: (e) => downloadCsv(e) }, '⭳ Export CSV'));
  }
  page.append(pageHead(isEmployee ? 'My Reports' : 'Reports', actions));
  if (!reports.length) { page.append(el('div', { class: 'empty' }, isEmployee ? 'You have not submitted any reports yet.' : 'No reports submitted yet.')); return; }
  page.append(reportsTable(reports));
}

function reportsTable(reports) {
  if (!reports.length) return el('div', { class: 'empty' }, 'No reports yet.');
  const table = el('table', {}, el('thead', {}, el('tr', {},
    el('th', {}, 'Submitted'), el('th', {}, 'Employee'), el('th', {}, 'Questionnaire'), el('th', {}, 'Answers'), el('th', {}, ''))));
  const tbody = el('tbody');
  reports.forEach((r) => tbody.append(el('tr', {},
    el('td', {}, fmtDate(r.submitted_at)),
    el('td', {}, r.user_name),
    el('td', {}, r.questionnaire_title),
    el('td', {}, String(r.answer_count)),
    el('td', {}, el('button', { class: 'btn ghost small', onclick: () => viewReport(r.id) }, 'View')))));
  table.append(tbody);
  return table;
}

async function viewReport(id) {
  const r = await api(`/reports/${id}`);
  const content = el('div', {},
    el('p', { class: 'muted' }, `${r.user_name} · ${fmtDate(r.submitted_at)}`),
    ...r.answers.map((a) => el('div', { class: 'report-answer' },
      el('div', { class: 'q' }, a.question),
      el('div', { class: 'a' }, a.value || '—'))));
  const backdrop = modal(r.questionnaire_title, content, async () => {}, 'Close');
  backdrop.querySelector('.modal-actions').innerHTML = '';
  backdrop.querySelector('.modal-actions').append(
    el('button', { type: 'button', class: 'btn primary', style: 'width:auto', onclick: () => backdrop.remove() }, 'Close'));
}

async function downloadCsv(e) {
  e.preventDefault();
  const res = await fetch('/api/reports/export/csv', { headers: { Authorization: `Bearer ${state.token}` } });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'daily-reports.csv'; a.click();
  URL.revokeObjectURL(url);
}

/* ---- Tasks ---- */
async function renderTasks() {
  const page = $('#page');
  page.innerHTML = 'Loading…';
  const canAssign = state.user.role === 'admin' || state.user.role === 'dept_head';
  const [tasks, users] = await Promise.all([
    api('/tasks'),
    canAssign ? api('/users').catch(() => []) : [],
  ]);
  page.innerHTML = '';
  const isEmployee = state.user.role === 'employee';
  const actions = canAssign
    ? [el('button', { class: 'btn primary', style: 'width:auto', onclick: () => taskModal(users) }, '+ Assign task')]
    : [];
  page.append(pageHead(isEmployee ? 'My Tasks' : 'Tasks', actions));
  if (!tasks.length) { page.append(el('div', { class: 'empty' }, 'No tasks.')); return; }
  const table = el('table', {}, el('thead', {}, el('tr', {},
    el('th', {}, 'Task'), el('th', {}, 'Assignee'), el('th', {}, 'Due'), el('th', {}, 'Status'), el('th', {}, ''))));
  const tbody = el('tbody');
  tasks.forEach((t) => {
    const statusSel = el('select', { onchange: async (e) => {
      await api(`/tasks/${t.id}`, { method: 'PATCH', body: { status: e.target.value } });
      toast('Task updated'); renderTasks();
    } }, ...['pending', 'in_progress', 'done'].map((s) =>
      el('option', { value: s, selected: t.status === s }, s.replace('_', ' '))));
    tbody.append(el('tr', {},
      el('td', {}, el('div', {}, el('strong', {}, t.title), t.description ? el('div', { class: 'muted' }, t.description) : null)),
      el('td', {}, t.assignee_name),
      el('td', {}, t.due_date || '—'),
      el('td', {}, statusSel),
      el('td', {}, canAssign ? el('button', { class: 'btn danger small', onclick: () => delTask(t) }, 'Delete') : null)));
  });
  table.append(tbody);
  page.append(table);
}

function taskModal(users) {
  const title = el('input', { required: true });
  const desc = el('textarea', {});
  const assignee = el('select', { required: true }, el('option', { value: '' }, '— choose —'),
    ...users.filter((u) => u.role !== 'admin').map((u) => el('option', { value: u.id }, `${u.name} (${u.email})`)));
  const due = el('input', { type: 'date' });
  const content = el('div', {},
    el('label', {}, 'Title', title),
    el('label', {}, 'Description', desc),
    el('label', {}, 'Assign to', assignee),
    el('label', {}, 'Due date', due));
  modal('Assign task', content, async () => {
    if (!assignee.value) throw new Error('Choose an assignee');
    await api('/tasks', { method: 'POST', body: {
      title: title.value.trim(), description: desc.value.trim(),
      assigned_to: Number(assignee.value), due_date: due.value || null } });
    toast('Task assigned');
    renderTasks();
  }, 'Assign');
}

async function delTask(t) {
  if (!confirm(`Delete task "${t.title}"?`)) return;
  await api(`/tasks/${t.id}`, { method: 'DELETE' });
  toast('Task deleted');
  renderTasks();
}

/* ------------------------------------------------------------------ */
boot();
