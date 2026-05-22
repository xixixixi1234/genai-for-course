import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import 'dotenv/config';

// SQLite: prefer better-sqlite3 (recommended for production, best performance)
// fall back to Node 22+ built-in node:sqlite (experimental but API-compatible)
let Database;
try {
  Database = (await import('better-sqlite3')).default;
} catch (e) {
  const { DatabaseSync } = await import('node:sqlite');
  Database = function(path) {
    const db = new DatabaseSync(path);
    // adapt to better-sqlite3 API
    return {
      pragma: (s) => db.exec(`PRAGMA ${s}`),
      exec: (s) => db.exec(s),
      prepare: (s) => {
        const stmt = db.prepare(s);
        return {
          run: (...args) => stmt.run(...args),
          get: (...args) => stmt.get(...args),
          all: (...args) => stmt.all(...args),
        };
      }
    };
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

if (!GEMINI_API_KEY) {
  console.warn('⚠️  GEMINI_API_KEY is not set — AI chat will be unavailable. Please edit .env');
}

// ───── Database ─────
const dbPath = path.join(__dirname, 'data.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    session_token TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL,
    last_active INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    content TEXT NOT NULL,
    file_path TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    case_id INTEGER,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    response_ms INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (student_id) REFERENCES students(id),
    FOREIGN KEY (case_id) REFERENCES cases(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER DEFAULT 0,
    FOREIGN KEY (student_id) REFERENCES students(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_student ON messages(student_id);
  CREATE INDEX IF NOT EXISTS idx_messages_case ON messages(case_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id);
`);

// ───── File uploads ─────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safe = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext;
    cb(null, safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ───── App ─────
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/uploads', express.static(uploadDir));

// ───── Helpers ─────
function now() { return Date.now(); }

function getStudentByToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM students WHERE session_token = ?').get(token);
}

function authStudent(req, res, next) {
  const token = req.headers['x-session-token'] || req.query.token;
  const student = getStudentByToken(token);
  if (!student) return res.status(401).json({ error: 'Not signed in or session expired' });
  req.student = student;
  db.prepare('UPDATE students SET last_active = ? WHERE id = ?').run(now(), student.id);
  next();
}

function authAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.query.password;
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Incorrect admin password' });
  next();
}

// ───── Student API ─────

// Sign up / sign in (by name)
app.post('/api/login', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name || name.length > 50) return res.status(400).json({ error: 'Please enter a valid name (1–50 characters)' });

  const token = crypto.randomBytes(24).toString('hex');
  const ts = now();
  const result = db.prepare(
    'INSERT INTO students (name, session_token, created_at, last_active) VALUES (?, ?, ?, ?)'
  ).run(name, token, ts, ts);
  const studentId = result.lastInsertRowid;

  // start a new session
  db.prepare('INSERT INTO sessions (student_id, started_at) VALUES (?, ?)').run(studentId, ts);

  // Seed a welcome message from the AI so the free-chat view isn't empty
  const firstName = name.split(/\s+/)[0];
  const welcomeMessage = `👋 Welcome to **GRA6842 — Mastering Negotiation**, ${firstName}!

I'm Apprentice, your AI sparring partner for this course. Think of me as someone you can argue with, test ideas on, and rehearse difficult conversations with — anytime, no judgment.

A few ways we can work together:

📚 **Pick a case** from the left sidebar — I'll discuss it with you, ask hard questions, and help you stress-test your strategy.

💭 **Just talk** right here — bring me a real negotiation you're facing (a salary discussion, a vendor dispute, a tough family conversation), or any concept you want to chew on.

🎯 **What I'll do**: I'll guide your thinking through questions rather than handing over answers. The goal is for *you* to develop sharper instincts, not for me to do the work for you.

So — what's on your mind today? A case you've been assigned, a real situation you're prepping for, or something from class you want to dig into?`;

  db.prepare(
    'INSERT INTO messages (student_id, case_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(studentId, null, 'assistant', welcomeMessage, ts);

  res.json({ token, name, student_id: studentId });
});

// Heartbeat: keep session duration updated
app.post('/api/heartbeat', authStudent, (req, res) => {
  const student = req.student;
  const ts = now();
  // find the student's most recent session
  const sess = db.prepare(
    'SELECT * FROM sessions WHERE student_id = ? ORDER BY started_at DESC LIMIT 1'
  ).get(student.id);

  if (sess) {
    const duration = ts - sess.started_at;
    db.prepare('UPDATE sessions SET duration_ms = ?, ended_at = ? WHERE id = ?')
      .run(duration, ts, sess.id);
  }
  res.json({ ok: true });
});

// List cases
app.get('/api/cases', authStudent, (req, res) => {
  const cases = db.prepare(
    'SELECT id, title, description, file_path, created_at FROM cases ORDER BY created_at DESC'
  ).all();
  res.json({ cases });
});

// Get a single case
app.get('/api/cases/:id', authStudent, (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  res.json({ case: c });
});

// Get student chat history (grouped by case)
app.get('/api/messages', authStudent, (req, res) => {
  const caseId = req.query.case_id || null;
  let rows;
  if (caseId) {
    rows = db.prepare(
      'SELECT id, role, content, created_at FROM messages WHERE student_id = ? AND case_id = ? ORDER BY created_at ASC'
    ).all(req.student.id, caseId);
  } else {
    rows = db.prepare(
      'SELECT id, role, content, created_at FROM messages WHERE student_id = ? AND case_id IS NULL ORDER BY created_at ASC'
    ).all(req.student.id);
  }
  res.json({ messages: rows });
});

// Chat: call Gemini
app.post('/api/chat', authStudent, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY' });
  }
  const { message, case_id } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }
  if (message.length > 8000) {
    return res.status(400).json({ error: 'Message too long (8000 char limit)' });
  }

  // Validate case_id
  let validCaseId = null;
  let currentCase = null;
  if (case_id) {
    currentCase = db.prepare('SELECT title, description, content FROM cases WHERE id = ?').get(case_id);
    if (!currentCase) {
      return res.status(400).json({ error: 'Case not found' });
    }
    validCaseId = case_id;
  }

  const startTs = now();

  // Save user message
  const userMsgResult = db.prepare(
    'INSERT INTO messages (student_id, case_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(req.student.id, validCaseId, 'user', message, startTs);
  const userMsgId = userMsgResult.lastInsertRowid;

  // Pull last 20 messages as context
  let history;
  if (validCaseId) {
    history = db.prepare(
      'SELECT role, content FROM messages WHERE student_id = ? AND case_id = ? ORDER BY created_at DESC LIMIT 20'
    ).all(req.student.id, validCaseId).reverse();
  } else {
    history = db.prepare(
      'SELECT role, content FROM messages WHERE student_id = ? AND case_id IS NULL ORDER BY created_at DESC LIMIT 20'
    ).all(req.student.id).reverse();
  }

  // System prompt: negotiation course mentor
  let systemPrompt = `You are Apprentice, the AI mentor for GRA6842 — Mastering Negotiation, a graduate-level negotiation course. Your role is to help students sharpen their negotiation thinking through Socratic dialogue.

Core principles:
- Guide, don't tell. Use questions, hypotheticals, and counterexamples to draw out the student's reasoning rather than handing them frameworks.
- Push back gently. Negotiation involves trade-offs, blind spots, and emotional traps. When a student gives a glib or one-sided answer, probe deeper: "What would the other side say to that?" "What's the cost of that move?"
- Use concrete language. Reference real negotiation concepts when relevant (BATNA, ZOPA, anchoring, interests vs. positions, reservation price, etc.), but introduce them as tools the student can apply, not jargon to memorize.
- Stay warm and curious. Affirm good thinking. When a student struggles, first understand their reasoning, then offer a question or angle they haven't considered.
- Be concise. 2–4 short paragraphs is usually enough. End with a question or invitation to go deeper.

The student's name is ${req.student.name}. Address them by name occasionally — it builds rapport.`;

  if (currentCase) {
    systemPrompt += `\n\nThe student is currently working through this case:\nTitle: ${currentCase.title}\n${currentCase.description ? 'Brief: ' + currentCase.description + '\n' : ''}Case material:\n${currentCase.content}\n\nKeep the discussion grounded in this case. Reference specific details from it when challenging the student's thinking.`;
  }

  // Gemini format
  const contents = history.map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
        }
      })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', errText);
      // Rollback user message to avoid dangling entries
      db.prepare('DELETE FROM messages WHERE id = ?').run(userMsgId);
      return res.status(502).json({ error: 'Gemini API call failed, please try again', detail: errText.slice(0, 300) });
    }

    const data = await geminiRes.json();
    const reply = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '(No reply, please try asking again)';
    const elapsed = now() - startTs;

    // Save assistant message
    db.prepare(
      'INSERT INTO messages (student_id, case_id, role, content, response_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.student.id, validCaseId, 'assistant', reply, elapsed, now());

    res.json({ reply, elapsed_ms: elapsed });
  } catch (err) {
    console.error(err);
    db.prepare('DELETE FROM messages WHERE id = ?').run(userMsgId);
    res.status(500).json({ error: 'Failed to call AI', detail: err.message });
  }
});

// ───── Instructor API ─────

// Verify password
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Incorrect password' });
  res.json({ ok: true });
});

// Overview stats
app.get('/api/admin/stats', authAdmin, (req, res) => {
  const totalStudents = db.prepare('SELECT COUNT(*) as c FROM students').get().c;
  const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  const totalCases = db.prepare('SELECT COUNT(*) as c FROM cases').get().c;
  const totalUserMessages = db.prepare("SELECT COUNT(*) as c FROM messages WHERE role='user'").get().c;
  res.json({ totalStudents, totalMessages, totalCases, totalUserMessages });
});

// Students list + time on site
app.get('/api/admin/students', authAdmin, (req, res) => {
  const students = db.prepare(`
    SELECT
      s.id, s.name, s.created_at, s.last_active,
      COALESCE(SUM(ss.duration_ms), 0) as total_duration_ms,
      (SELECT COUNT(*) FROM messages m WHERE m.student_id = s.id AND m.role='user') as prompt_count
    FROM students s
    LEFT JOIN sessions ss ON ss.student_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `).all();
  res.json({ students });
});

// All prompt records for a student
app.get('/api/admin/students/:id/messages', authAdmin, (req, res) => {
  const messages = db.prepare(`
    SELECT m.*, c.title as case_title
    FROM messages m
    LEFT JOIN cases c ON c.id = m.case_id
    WHERE m.student_id = ?
    ORDER BY m.created_at ASC
  `).all(req.params.id);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  res.json({ student, messages });
});

// Case engagement
app.get('/api/admin/case-usage', authAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT
      c.id, c.title, c.created_at,
      COUNT(DISTINCT m.student_id) as unique_students,
      COUNT(m.id) as total_messages
    FROM cases c
    LEFT JOIN messages m ON m.case_id = c.id
    GROUP BY c.id
    ORDER BY total_messages DESC
  `).all();
  res.json({ cases: rows });
});

// Create case
app.post('/api/admin/cases', authAdmin, upload.single('file'), (req, res) => {
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const content = (req.body.content || '').trim();
  if (!title || !content) return res.status(400).json({ error: 'Title and case text are required' });

  const filePath = req.file ? '/uploads/' + req.file.filename : null;
  const result = db.prepare(
    'INSERT INTO cases (title, description, content, file_path, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(title, description, content, filePath, now());

  res.json({ id: result.lastInsertRowid });
});

// Delete case
app.delete('/api/admin/cases/:id', authAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (c && c.file_path) {
    const filename = path.basename(c.file_path);
    const fullPath = path.join(uploadDir, filename);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }
  db.prepare('DELETE FROM cases WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// List cases (admin sees full content)
app.get('/api/admin/cases', authAdmin, (req, res) => {
  const cases = db.prepare('SELECT * FROM cases ORDER BY created_at DESC').all();
  res.json({ cases });
});

// ───── Routes ─────
app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// Global error handler (multer file too large, etc.)
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (10 MB limit)' });
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`\n  ✦ Studio is running`);
  console.log(`  → Student app:    http://localhost:${PORT}/`);
  console.log(`  → Instructor:     http://localhost:${PORT}/admin`);
  console.log(`  → Model:          ${GEMINI_MODEL}`);
  console.log(`  → Database:       ${dbPath}\n`);
});
