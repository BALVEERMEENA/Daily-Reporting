'use strict';

const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../auth');

const router = express.Router();

router.use(authRequired);

function loadQuestions(questionnaireId) {
  const rows = db
    .prepare('SELECT * FROM questions WHERE questionnaire_id = ? ORDER BY position, id')
    .all(questionnaireId);
  return rows.map((q) => ({ ...q, options: q.options ? JSON.parse(q.options) : null }));
}

function canManage(user, questionnaire) {
  if (user.role === 'admin') return true;
  if (user.role === 'dept_head') {
    return questionnaire.created_by === user.id || questionnaire.department_id === user.department_id;
  }
  return false;
}

// GET /api/questionnaires — managers see the ones they can manage.
router.get('/', requireRole('admin', 'dept_head'), (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = db.prepare('SELECT * FROM questionnaires ORDER BY created_at DESC').all();
  } else {
    rows = db
      .prepare(
        'SELECT * FROM questionnaires WHERE created_by = ? OR department_id = ? ORDER BY created_at DESC'
      )
      .all(req.user.id, req.user.department_id);
  }
  const withCounts = rows.map((q) => ({
    ...q,
    question_count: db
      .prepare('SELECT COUNT(*) AS c FROM questions WHERE questionnaire_id = ?')
      .get(q.id).c,
    assignment_count: db
      .prepare('SELECT COUNT(*) AS c FROM assignments WHERE questionnaire_id = ?')
      .get(q.id).c,
  }));
  res.json(withCounts);
});

// GET /api/questionnaires/:id — full detail with questions.
router.get('/:id', requireRole('admin', 'dept_head'), (req, res) => {
  const q = db.prepare('SELECT * FROM questionnaires WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Questionnaire not found' });
  if (!canManage(req.user, q)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ ...q, questions: loadQuestions(q.id) });
});

// POST /api/questionnaires — create with nested questions.
router.post('/', requireRole('admin', 'dept_head'), (req, res) => {
  const { title, description, questions } = req.body || {};
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  const department_id =
    req.user.role === 'dept_head' ? req.user.department_id : req.body.department_id || null;

  const create = db.transaction(() => {
    const info = db
      .prepare(
        'INSERT INTO questionnaires (title, description, created_by, department_id) VALUES (?, ?, ?, ?)'
      )
      .run(title.trim(), description || null, req.user.id, department_id);
    saveQuestions(info.lastInsertRowid, questions || []);
    return info.lastInsertRowid;
  });
  const id = create();
  const q = db.prepare('SELECT * FROM questionnaires WHERE id = ?').get(id);
  res.status(201).json({ ...q, questions: loadQuestions(id) });
});

// PUT /api/questionnaires/:id — replace questions and update metadata.
router.put('/:id', requireRole('admin', 'dept_head'), (req, res) => {
  const q = db.prepare('SELECT * FROM questionnaires WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Questionnaire not found' });
  if (!canManage(req.user, q)) return res.status(403).json({ error: 'Insufficient permissions' });

  const { title, description, active, questions } = req.body || {};
  const update = db.transaction(() => {
    db.prepare(
      `UPDATE questionnaires SET
         title = COALESCE(?, title),
         description = ?,
         active = COALESCE(?, active)
       WHERE id = ?`
    ).run(
      title ? title.trim() : null,
      description === undefined ? q.description : description,
      active === undefined ? null : active ? 1 : 0,
      q.id
    );
    if (Array.isArray(questions)) {
      db.prepare('DELETE FROM questions WHERE questionnaire_id = ?').run(q.id);
      saveQuestions(q.id, questions);
    }
  });
  update();
  const updated = db.prepare('SELECT * FROM questionnaires WHERE id = ?').get(q.id);
  res.json({ ...updated, questions: loadQuestions(q.id) });
});

// DELETE /api/questionnaires/:id
router.delete('/:id', requireRole('admin', 'dept_head'), (req, res) => {
  const q = db.prepare('SELECT * FROM questionnaires WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Questionnaire not found' });
  if (!canManage(req.user, q)) return res.status(403).json({ error: 'Insufficient permissions' });
  db.prepare('DELETE FROM questionnaires WHERE id = ?').run(q.id);
  res.json({ ok: true });
});

const CHOICE_TYPES = new Set(['select', 'radio', 'checkbox']);

function saveQuestions(questionnaireId, questions) {
  const insert = db.prepare(
    'INSERT INTO questions (questionnaire_id, text, type, options, required, position) VALUES (?, ?, ?, ?, ?, ?)'
  );
  questions.forEach((raw, index) => {
    if (!raw || !raw.text || !raw.text.trim()) return;
    const type = raw.type || 'text';
    const options =
      CHOICE_TYPES.has(type) && Array.isArray(raw.options)
        ? JSON.stringify(raw.options.filter((o) => o !== '' && o != null))
        : null;
    insert.run(
      questionnaireId,
      raw.text.trim(),
      type,
      options,
      raw.required ? 1 : 0,
      raw.position != null ? raw.position : index
    );
  });
}

module.exports = router;
