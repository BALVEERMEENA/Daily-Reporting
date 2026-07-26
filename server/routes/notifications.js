'use strict';

const express = require('express');
const db = require('../db');
const { authRequired } = require('../auth');

const router = express.Router();

router.use(authRequired);

// GET /api/notifications — the caller's notifications, newest first.
router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(req.user.id);
  const unread = rows.filter((n) => !n.is_read).length;
  res.json({ notifications: rows, unread });
});

// POST /api/notifications/:id/read — mark one as read.
router.post('/:id/read', (req, res) => {
  const info = db
    .prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Notification not found' });
  res.json({ ok: true });
});

// POST /api/notifications/read-all — mark all as read.
router.post('/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
