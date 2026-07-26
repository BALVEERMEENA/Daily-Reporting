'use strict';

// Public, unauthenticated endpoints for the "enter a code and report" flow.
const express = require('express');
const db = require('../db');

const router = express.Router();

function loadQuestions(questionnaireId) {
  return db
    .prepare('SELECT * FROM questions WHERE questionnaire_id = ? ORDER BY position, id')
    .all(questionnaireId)
    .map((q) => ({
      id: q.id,
      text: q.text,
      type: q.type,
      required: !!q.required,
      options: q.options ? JSON.parse(q.options) : null,
    }));
}

function resolveAssignment(code) {
  if (!code) return null;
  return db
    .prepare(
      `SELECT a.*, u.name AS user_name, q.title, q.description, q.active AS questionnaire_active
       FROM assignments a
       JOIN users u ON u.id = a.user_id
       JOIN questionnaires q ON q.id = a.questionnaire_id
       WHERE a.code = ?`
    )
    .get(String(code).trim().toUpperCase());
}

// POST /api/report/lookup — resolve a code into the questionnaire to fill in.
router.post('/lookup', (req, res) => {
  const assignment = resolveAssignment((req.body || {}).code);
  if (!assignment || !assignment.active) {
    return res.status(404).json({ error: 'That code is not valid. Please check and try again.' });
  }
  if (!assignment.questionnaire_active) {
    return res.status(410).json({ error: 'This questionnaire is no longer accepting responses.' });
  }
  res.json({
    assignment_id: assignment.id,
    employee_name: assignment.user_name,
    title: assignment.title,
    description: assignment.description,
    questions: loadQuestions(assignment.questionnaire_id),
    previous_submissions: db
      .prepare('SELECT COUNT(*) AS c FROM submissions WHERE assignment_id = ?')
      .get(assignment.id).c,
  });
});

// POST /api/report/submit — submit answers for a code.
router.post('/submit', (req, res) => {
  const { code, answers } = req.body || {};
  const assignment = resolveAssignment(code);
  if (!assignment || !assignment.active) {
    return res.status(404).json({ error: 'That code is not valid.' });
  }
  if (!assignment.questionnaire_active) {
    return res.status(410).json({ error: 'This questionnaire is no longer accepting responses.' });
  }
  const questions = db
    .prepare('SELECT * FROM questions WHERE questionnaire_id = ?')
    .all(assignment.questionnaire_id);

  // Validate required questions.
  const answerMap = new Map(
    Array.isArray(answers) ? answers.map((a) => [Number(a.question_id), a.value]) : []
  );
  for (const q of questions) {
    if (q.required) {
      const v = answerMap.get(q.id);
      const empty = v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');
      if (empty) {
        return res.status(400).json({ error: `"${q.text}" is required.` });
      }
    }
  }

  const submit = db.transaction(() => {
    const info = db
      .prepare(
        'INSERT INTO submissions (assignment_id, questionnaire_id, user_id) VALUES (?, ?, ?)'
      )
      .run(assignment.id, assignment.questionnaire_id, assignment.user_id);
    const insertAnswer = db.prepare(
      'INSERT INTO answers (submission_id, question_id, value) VALUES (?, ?, ?)'
    );
    for (const q of questions) {
      let value = answerMap.get(q.id);
      if (value == null) continue;
      if (Array.isArray(value)) value = value.join(', ');
      insertAnswer.run(info.lastInsertRowid, q.id, String(value));
    }
    return info.lastInsertRowid;
  });
  const submissionId = submit();
  res.status(201).json({ ok: true, submission_id: submissionId, submitted_at: new Date().toISOString() });
});

module.exports = router;
