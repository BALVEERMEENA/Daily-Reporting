'use strict';

const express = require('express');
const db = require('../db');
const { authRequired, requireRole, generateCode } = require('../auth');

const router = express.Router();

router.use(authRequired);

function uniqueCode() {
  // Extremely unlikely to collide, but guard anyway.
  for (let i = 0; i < 10; i++) {
    const code = generateCode();
    const exists = db.prepare('SELECT 1 FROM assignments WHERE code = ?').get(code);
    if (!exists) return code;
  }
  throw new Error('Could not generate a unique code');
}

// GET /api/assignments?questionnaire_id= — list assignments (with codes).
router.get('/', requireRole('admin', 'dept_head'), (req, res) => {
  const { questionnaire_id } = req.query;
  const params = [];
  let where = '1=1';
  if (questionnaire_id) {
    where += ' AND a.questionnaire_id = ?';
    params.push(questionnaire_id);
  }
  if (req.user.role === 'dept_head') {
    where += ' AND u.department_id = ?';
    params.push(req.user.department_id);
  }
  const rows = db
    .prepare(
      `SELECT a.*, u.name AS user_name, u.email AS user_email, q.title AS questionnaire_title,
              (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id = a.id) AS submission_count
       FROM assignments a
       JOIN users u ON u.id = a.user_id
       JOIN questionnaires q ON q.id = a.questionnaire_id
       WHERE ${where}
       ORDER BY a.created_at DESC`
    )
    .all(...params);
  res.json(rows);
});

// POST /api/assignments — assign a questionnaire to one or more users.
router.post('/', requireRole('admin', 'dept_head'), (req, res) => {
  const { questionnaire_id, user_ids } = req.body || {};
  if (!questionnaire_id || !Array.isArray(user_ids) || user_ids.length === 0) {
    return res.status(400).json({ error: 'questionnaire_id and user_ids[] are required' });
  }
  const questionnaire = db
    .prepare('SELECT * FROM questionnaires WHERE id = ?')
    .get(questionnaire_id);
  if (!questionnaire) return res.status(404).json({ error: 'Questionnaire not found' });

  const created = [];
  const assign = db.transaction(() => {
    for (const userId of user_ids) {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!user) continue;
      if (req.user.role === 'dept_head' && user.department_id !== req.user.department_id) {
        continue; // heads can only assign within their department
      }
      const existing = db
        .prepare('SELECT * FROM assignments WHERE questionnaire_id = ? AND user_id = ?')
        .get(questionnaire_id, userId);
      if (existing) {
        created.push(existing);
        continue;
      }
      const code = uniqueCode();
      const info = db
        .prepare('INSERT INTO assignments (questionnaire_id, user_id, code) VALUES (?, ?, ?)')
        .run(questionnaire_id, userId, code);
      const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(info.lastInsertRowid);
      created.push(assignment);
      // Notify the employee they have a new questionnaire.
      db.prepare(
        "INSERT INTO notifications (user_id, message, type, related_id) VALUES (?, ?, 'questionnaire', ?)"
      ).run(userId, `New questionnaire assigned: "${questionnaire.title}" — code ${code}`, info.lastInsertRowid);
    }
  });
  assign();
  res.status(201).json(created);
});

// POST /api/assignments/:id/regenerate — issue a fresh code.
router.post('/:id/regenerate', requireRole('admin', 'dept_head'), (req, res) => {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Assignment not found' });
  const code = uniqueCode();
  db.prepare('UPDATE assignments SET code = ? WHERE id = ?').run(code, a.id);
  res.json({ ...a, code });
});

// DELETE /api/assignments/:id
router.delete('/:id', requireRole('admin', 'dept_head'), (req, res) => {
  const info = db.prepare('DELETE FROM assignments WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Assignment not found' });
  res.json({ ok: true });
});

module.exports = router;
