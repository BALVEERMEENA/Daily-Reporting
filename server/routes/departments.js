'use strict';

const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../auth');

const router = express.Router();

router.use(authRequired);

// GET /api/departments — admins see all; dept heads/employees see their own.
router.get('/', (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = db
      .prepare(
        `SELECT d.*, u.name AS head_name,
                (SELECT COUNT(*) FROM users WHERE department_id = d.id) AS member_count
         FROM departments d
         LEFT JOIN users u ON u.id = d.head_user_id
         ORDER BY d.name`
      )
      .all();
  } else {
    rows = db
      .prepare(
        `SELECT d.*, u.name AS head_name,
                (SELECT COUNT(*) FROM users WHERE department_id = d.id) AS member_count
         FROM departments d
         LEFT JOIN users u ON u.id = d.head_user_id
         WHERE d.id = ?`
      )
      .all(req.user.department_id);
  }
  res.json(rows);
});

// POST /api/departments — admin only.
router.post('/', requireRole('admin'), (req, res) => {
  const { name, head_user_id } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Department name is required' });
  }
  try {
    const info = db
      .prepare('INSERT INTO departments (name, head_user_id) VALUES (?, ?)')
      .run(name.trim(), head_user_id || null);
    // If a head is assigned, promote that user and place them in the department.
    if (head_user_id) {
      db.prepare("UPDATE users SET role = 'dept_head', department_id = ? WHERE id = ?").run(
        info.lastInsertRowid,
        head_user_id
      );
    }
    res.status(201).json(db.prepare('SELECT * FROM departments WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A department with that name already exists' });
    }
    throw err;
  }
});

// PUT /api/departments/:id — admin only.
router.put('/:id', requireRole('admin'), (req, res) => {
  const { name, head_user_id } = req.body || {};
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
  if (!dept) return res.status(404).json({ error: 'Department not found' });

  db.prepare('UPDATE departments SET name = COALESCE(?, name), head_user_id = ? WHERE id = ?').run(
    name ? name.trim() : null,
    head_user_id || null,
    dept.id
  );
  if (head_user_id) {
    db.prepare("UPDATE users SET role = 'dept_head', department_id = ? WHERE id = ?").run(
      dept.id,
      head_user_id
    );
  }
  res.json(db.prepare('SELECT * FROM departments WHERE id = ?').get(dept.id));
});

// DELETE /api/departments/:id — admin only.
router.delete('/:id', requireRole('admin'), (req, res) => {
  const info = db.prepare('DELETE FROM departments WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Department not found' });
  res.json({ ok: true });
});

module.exports = router;
