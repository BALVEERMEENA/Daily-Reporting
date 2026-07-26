'use strict';

const db = require('./db');
const { hashPassword, generateCode } = require('./auth');

const DEFAULT_ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

/** Create the bootstrap admin account if the users table is empty. */
function ensureSeed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;
  db.prepare(
    "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')"
  ).run('Administrator', DEFAULT_ADMIN_EMAIL, hashPassword(DEFAULT_ADMIN_PASSWORD));
  console.log(
    `Seeded default admin account: ${DEFAULT_ADMIN_EMAIL} / ${DEFAULT_ADMIN_PASSWORD} ` +
      '(change this password after first login)'
  );
}

/** Populate a full demo dataset. Destructive-safe: only runs on an empty DB. */
function seedDemo() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) {
    console.log('Database already has users — skipping demo seed.');
    return;
  }

  const insertUser = db.prepare(
    'INSERT INTO users (name, email, password_hash, role, department_id) VALUES (?, ?, ?, ?, ?)'
  );
  const pw = hashPassword('password123');

  const adminId = insertUser.run('Administrator', DEFAULT_ADMIN_EMAIL, hashPassword(DEFAULT_ADMIN_PASSWORD), 'admin', null)
    .lastInsertRowid;

  const engDeptId = db.prepare('INSERT INTO departments (name) VALUES (?)').run('Engineering').lastInsertRowid;
  const salesDeptId = db.prepare('INSERT INTO departments (name) VALUES (?)').run('Sales').lastInsertRowid;

  const headEng = insertUser.run('Erin Head', 'erin@example.com', pw, 'dept_head', engDeptId).lastInsertRowid;
  db.prepare('UPDATE departments SET head_user_id = ? WHERE id = ?').run(headEng, engDeptId);

  const alice = insertUser.run('Alice Dev', 'alice@example.com', pw, 'employee', engDeptId).lastInsertRowid;
  const bob = insertUser.run('Bob Dev', 'bob@example.com', pw, 'employee', engDeptId).lastInsertRowid;
  const carol = insertUser.run('Carol Sales', 'carol@example.com', pw, 'employee', salesDeptId).lastInsertRowid;

  // A questionnaire for engineers.
  const engQ = db
    .prepare('INSERT INTO questionnaires (title, description, created_by, department_id) VALUES (?, ?, ?, ?)')
    .run('Engineering Daily Standup', 'What did you do today?', adminId, engDeptId).lastInsertRowid;
  const insertQuestion = db.prepare(
    'INSERT INTO questions (questionnaire_id, text, type, options, required, position) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insertQuestion.run(engQ, 'What did you complete today?', 'textarea', null, 1, 0);
  insertQuestion.run(engQ, 'Any blockers?', 'textarea', null, 0, 1);
  insertQuestion.run(engQ, 'Hours worked', 'number', null, 1, 2);
  insertQuestion.run(engQ, 'Mood', 'radio', JSON.stringify(['Great', 'OK', 'Struggling']), 0, 3);

  // A different questionnaire for sales.
  const salesQ = db
    .prepare('INSERT INTO questionnaires (title, description, created_by, department_id) VALUES (?, ?, ?, ?)')
    .run('Sales Daily Report', 'Track your sales activity', adminId, salesDeptId).lastInsertRowid;
  insertQuestion.run(salesQ, 'Calls made', 'number', null, 1, 0);
  insertQuestion.run(salesQ, 'Deals closed', 'number', null, 1, 1);
  insertQuestion.run(salesQ, 'Notes', 'textarea', null, 0, 2);

  // Assign with unique codes (this is what employees type in).
  const assign = db.prepare('INSERT INTO assignments (questionnaire_id, user_id, code) VALUES (?, ?, ?)');
  assign.run(engQ, alice, generateCode());
  assign.run(engQ, bob, generateCode());
  assign.run(salesQ, carol, generateCode());

  console.log('Demo data seeded. Accounts (password: password123 unless noted):');
  console.log(`  admin  : ${DEFAULT_ADMIN_EMAIL} / ${DEFAULT_ADMIN_PASSWORD}`);
  console.log('  head   : erin@example.com');
  console.log('  emp    : alice@example.com, bob@example.com, carol@example.com');
  console.log('\nAssignment codes:');
  db.prepare(
    `SELECT a.code, u.name, q.title FROM assignments a
     JOIN users u ON u.id = a.user_id JOIN questionnaires q ON q.id = a.questionnaire_id`
  )
    .all()
    .forEach((r) => console.log(`  ${r.code}  ${r.name} → ${r.title}`));
}

module.exports = { ensureSeed, seedDemo };

if (require.main === module) {
  if (process.argv.includes('--demo')) {
    seedDemo();
  } else {
    ensureSeed();
  }
}
