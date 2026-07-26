'use strict';

const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../auth');

const router = express.Router();

router.use(authRequired);

// GET /api/tasks — employees see tasks assigned to them; managers see relevant tasks.
router.get('/', (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = db
      .prepare(
        `SELECT t.*, u.name AS assignee_name, b.name AS assigner_name
         FROM tasks t
         JOIN users u ON u.id = t.assigned_to
         LEFT JOIN users b ON b.id = t.assigned_by
         ORDER BY t.created_at DESC`
      )
      .all();
  } else if (req.user.role === 'dept_head') {
    rows = db
      .prepare(
        `SELECT t.*, u.name AS assignee_name, b.name AS assigner_name
         FROM tasks t
         JOIN users u ON u.id = t.assigned_to
         LEFT JOIN users b ON b.id = t.assigned_by
         WHERE u.department_id = ? OR t.assigned_to = ? OR t.assigned_by = ?
         ORDER BY t.created_at DESC`
      )
      .all(req.user.department_id, req.user.id, req.user.id);
  } else {
    rows = db
      .prepare(
        `SELECT t.*, u.name AS assignee_name, b.name AS assigner_name
         FROM tasks t
         JOIN users u ON u.id = t.assigned_to
         LEFT JOIN users b ON b.id = t.assigned_by
         WHERE t.assigned_to = ?
         ORDER BY t.created_at DESC`
      )
      .all(req.user.id);
  }
  res.json(rows);
});

// POST /api/tasks — admins and dept heads assign tasks.
router.post('/', requireRole('admin', 'dept_head'), (req, res) => {
  const { title, description, assigned_to, due_date } = req.body || {};
  if (!title || !title.trim() || !assigned_to) {
    return res.status(400).json({ error: 'Title and assignee are required' });
  }
  const assignee = db.prepare('SELECT * FROM users WHERE id = ?').get(assigned_to);
  if (!assignee) return res.status(404).json({ error: 'Assignee not found' });
  if (req.user.role === 'dept_head' && assignee.department_id !== req.user.department_id) {
    return res.status(403).json({ error: 'You can only assign tasks within your department' });
  }

  const create = db.transaction(() => {
    const info = db
      .prepare(
        'INSERT INTO tasks (title, description, assigned_to, assigned_by, due_date) VALUES (?, ?, ?, ?, ?)'
      )
      .run(title.trim(), description || null, assigned_to, req.user.id, due_date || null);
    db.prepare(
      "INSERT INTO notifications (user_id, message, type, related_id) VALUES (?, ?, 'task', ?)"
    ).run(assigned_to, `New task assigned: "${title.trim()}"`, info.lastInsertRowid);
    return info.lastInsertRowid;
  });
  const id = create();
  res.status(201).json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
});

// PATCH /api/tasks/:id — update status (assignee) or details (manager).
router.patch('/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const isAssignee = task.assigned_to === req.user.id;
  const isManager = req.user.role === 'admin' || req.user.role === 'dept_head';
  if (!isAssignee && !isManager) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  const { status, title, description, due_date } = req.body || {};
  if (status && !['pending', 'in_progress', 'done'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  db.prepare(
    `UPDATE tasks SET
       status = COALESCE(?, status),
       title = COALESCE(?, title),
       description = COALESCE(?, description),
       due_date = COALESCE(?, due_date)
     WHERE id = ?`
  ).run(
    status || null,
    isManager && title ? title.trim() : null,
    isManager && description !== undefined ? description : null,
    isManager && due_date !== undefined ? due_date : null,
    task.id
  );

  // Notify the assigner when the assignee completes the task.
  if (status === 'done' && isAssignee && task.assigned_by && task.assigned_by !== req.user.id) {
    db.prepare(
      "INSERT INTO notifications (user_id, message, type, related_id) VALUES (?, ?, 'task', ?)"
    ).run(task.assigned_by, `Task completed: "${task.title}"`, task.id);
  }
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id));
});

// DELETE /api/tasks/:id — managers only.
router.delete('/:id', requireRole('admin', 'dept_head'), (req, res) => {
  const info = db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Task not found' });
  res.json({ ok: true });
});

module.exports = router;
