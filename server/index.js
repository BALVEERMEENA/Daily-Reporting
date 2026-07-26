'use strict';

const path = require('path');
const express = require('express');

const app = express();

app.use(express.json({ limit: '1mb' }));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/departments', require('./routes/departments'));
app.use('/api/users', require('./routes/users'));
app.use('/api/questionnaires', require('./routes/questionnaires'));
app.use('/api/assignments', require('./routes/assignments'));
app.use('/api/report', require('./routes/public')); // unauthenticated code flow
app.use('/api/reports', require('./routes/reports'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/notifications', require('./routes/notifications'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// SPA fallback: send index.html for any non-API GET that isn't a static file.
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// JSON error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  // Ensure the database is initialised and seeded before serving.
  require('./seed').ensureSeed();
  app.listen(PORT, () => {
    console.log(`Daily Reporting server listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
