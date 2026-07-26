'use strict';

const express = require('express');
const db = require('../db');
const { authRequired } = require('../auth');

const router = express.Router();

router.use(authRequired);

/**
 * Build a WHERE clause that restricts submissions to what the current user is
 * allowed to see:
 *   - employee  -> only their own submissions
 *   - dept_head -> submissions from users in their department
 *   - admin     -> everything
 */
function scopeClause(user, alias = 's') {
  if (user.role === 'admin') return { sql: '1=1', params: [] };
  if (user.role === 'dept_head') {
    return {
      sql: `${alias}.user_id IN (SELECT id FROM users WHERE department_id = ?)`,
      params: [user.department_id],
    };
  }
  return { sql: `${alias}.user_id = ?`, params: [user.id] };
}

// GET /api/reports — list submissions the caller may see.
router.get('/', (req, res) => {
  const scope = scopeClause(req.user);
  const params = [...scope.params];
  let extra = '';
  if (req.query.user_id) {
    extra += ' AND s.user_id = ?';
    params.push(req.query.user_id);
  }
  if (req.query.questionnaire_id) {
    extra += ' AND s.questionnaire_id = ?';
    params.push(req.query.questionnaire_id);
  }
  const rows = db
    .prepare(
      `SELECT s.id, s.submitted_at, s.questionnaire_id, s.user_id,
              u.name AS user_name, q.title AS questionnaire_title,
              (SELECT COUNT(*) FROM answers a WHERE a.submission_id = s.id) AS answer_count
       FROM submissions s
       JOIN users u ON u.id = s.user_id
       JOIN questionnaires q ON q.id = s.questionnaire_id
       WHERE ${scope.sql}${extra}
       ORDER BY s.submitted_at DESC`
    )
    .all(...params);
  res.json(rows);
});

// GET /api/reports/:id — a single submission with its answers.
router.get('/:id', (req, res) => {
  const submission = loadSubmission(req.params.id);
  if (!submission) return res.status(404).json({ error: 'Report not found' });
  if (!canView(req.user, submission)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  res.json(submission);
});

// GET /api/reports/export/csv — export the visible reports as CSV.
router.get('/export/csv', (req, res) => {
  const scope = scopeClause(req.user);
  const params = [...scope.params];
  let extra = '';
  if (req.query.questionnaire_id) {
    extra += ' AND s.questionnaire_id = ?';
    params.push(req.query.questionnaire_id);
  }
  const rows = db
    .prepare(
      `SELECT s.id AS submission_id, s.submitted_at, u.name AS employee,
              q.title AS questionnaire, qs.text AS question, a.value AS answer
       FROM submissions s
       JOIN users u ON u.id = s.user_id
       JOIN questionnaires q ON q.id = s.questionnaire_id
       LEFT JOIN answers a ON a.submission_id = s.id
       LEFT JOIN questions qs ON qs.id = a.question_id
       WHERE ${scope.sql}${extra}
       ORDER BY s.submitted_at DESC, qs.position`
    )
    .all(...params);

  const header = ['submission_id', 'submitted_at', 'employee', 'questionnaire', 'question', 'answer'];
  const csv = [header.join(',')]
    .concat(
      rows.map((r) =>
        header.map((h) => csvCell(r[h])).join(',')
      )
    )
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="daily-reports.csv"');
  res.send(csv);
});

function csvCell(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function loadSubmission(id) {
  const s = db
    .prepare(
      `SELECT s.*, u.name AS user_name, u.department_id, q.title AS questionnaire_title
       FROM submissions s
       JOIN users u ON u.id = s.user_id
       JOIN questionnaires q ON q.id = s.questionnaire_id
       WHERE s.id = ?`
    )
    .get(id);
  if (!s) return null;
  s.answers = db
    .prepare(
      `SELECT a.question_id, qs.text AS question, qs.type, a.value
       FROM answers a JOIN questions qs ON qs.id = a.question_id
       WHERE a.submission_id = ?
       ORDER BY qs.position, qs.id`
    )
    .all(id);
  return s;
}

function canView(user, submission) {
  if (user.role === 'admin') return true;
  if (user.role === 'dept_head') return submission.department_id === user.department_id;
  return submission.user_id === user.id;
}

module.exports = router;
