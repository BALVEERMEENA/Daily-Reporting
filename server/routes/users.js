'use strict';

const express = require('express');
const db = require('../db');
const { authRequired, requireRole, hashPassword } = require('../auth');

const router = express.Router();

router.use(authRequired);

const PUBLIC_COLUMNS =
  'u.id, u.name, u.email, u.role, u.department_id, u.created_at';

// GET /api/users — admins see everyone; dept heads see their department only.
router.get('/', requireRole('admin', 'dept_head'), (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = db
      .prepare(
        `SELECT ${PUBLIC_COLUMNS}, d.name AS department_name
         FROM users u LEFT JOIN departments d ON d.id = u.department_id
         ORDER BY u.name`
      )
      .all();
  } else {
    rows = db
      .prepare(
        `SELECT ${PUBLIC_COLUMNS}, d.name AS department_name
         FROM users u LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.department_id = ?
         ORDER BY u.name`
      )
      .all(req.user.department_id);
  }
  res.json(rows);
});

// POST /api/users — admin creates any user; dept head creates employees in own dept.
router.post('/', requireRole('admin', 'dept_head'), (req, res) => {
  let { name, email, password, role, department_id } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }
  email = String(email).toLowerCase().trim();
  role = role || 'employee';

  if (req.user.role === 'dept_head') {
    // Dept heads may only add employees to their own department.
    role = 'employee';
    department_id = req.user.department_id;
  }
  if (!['admin', 'dept_head', 'employee'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    const info = db
      .prepare(
        'INSERT INTO users (name, email, password_hash, role, department_id) VALUES (?, ?, ?, ?, ?)'
      )
      .run(name.trim(), email, hashPassword(password), role, department_id || null);
    res
      .status(201)
      .json(db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users u WHERE u.id = ?`).get(info.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    throw err;
  }
});

// PUT /api/users/:id — admin only (role/department changes are sensitive).
router.put('/:id', requireRole('admin'), (req, res) => {
  const { name, email, role, department_id, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (role && !['admin', 'dept_head', 'employee'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  try {
    db.prepare(
      `UPDATE users SET
         name = COALESCE(?, name),
         email = COALESCE(?, email),
         role = COALESCE(?, role),
         department_id = ?,
         password_hash = COALESCE(?, password_hash)
       WHERE id = ?`
    ).run(
      name ? name.trim() : null,
      email ? String(email).toLowerCase().trim() : null,
      role || null,
      department_id === undefined ? user.department_id : department_id || null,
      password ? hashPassword(password) : null,
      user.id
    );
    res.json(db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users u WHERE u.id = ?`).get(user.id));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    throw err;
  }
});

// DELETE /api/users/:id — admin only.
router.delete('/:id', requireRole('admin'), (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

module.exports = router;
