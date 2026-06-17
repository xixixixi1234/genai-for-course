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

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_student ON messages(student_id);
  CREATE INDEX IF NOT EXISTS idx_messages_case ON messages(case_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id);
`);

// Add sentiment column if not present (safe migration for existing DBs)
try {
  db.exec(`ALTER TABLE messages ADD COLUMN sentiment TEXT`);
} catch (e) { /* column already exists */ }

// ───── Default settings (used on first run; admin can override via UI) ─────
const DEFAULT_WELCOME = `👋 Welcome to **GRA6842 — Mastering Negotiation**, {name}!

I'm Digital Robin, your AI sparring partner for this course. Think of me as someone you can argue with, test ideas on, and rehearse difficult conversations with — anytime, no judgment.

A few ways we can work together:

📚 **Pick a case** from the left sidebar — I'll discuss it with you, ask hard questions, and help you stress-test your strategy.

💭 **Just talk** right here — bring me a real negotiation you're facing (a salary discussion, a vendor dispute, a tough family conversation), or any concept you want to chew on.

🎯 **What I'll do**: I'll guide your thinking through questions rather than handing over answers. The goal is for *you* to develop sharper instincts, not for me to do the work for you.

So — what's on your mind today? A case you've been assigned, a real situation you're prepping for, or something from class you want to dig into?`;

const DEFAULT_SYSTEM_PROMPT = `You are Digital Robin, the AI mentor for GRA6842 — Mastering Negotiation, a graduate-level negotiation course. Your role is to help students sharpen their negotiation thinking through Socratic dialogue.

Core principles:
- Guide, don't tell. Use questions, hypotheticals, and counterexamples to draw out the student's reasoning rather than handing them frameworks.
- Push back gently. Negotiation involves trade-offs, blind spots, and emotional traps. When a student gives a glib or one-sided answer, probe deeper: "What would the other side say to that?" "What's the cost of that move?"
- Use concrete language. Reference real negotiation concepts when relevant (BATNA, ZOPA, anchoring, interests vs. positions, reservation price, etc.), but introduce them as tools the student can apply, not jargon to memorize.
- Stay warm and curious. Affirm good thinking. When a student struggles, first understand their reasoning, then offer a question or angle they haven't considered.
- Be concise. 2–4 short paragraphs is usually enough. End with a question or invitation to go deeper.`;

const DEFAULT_COURSE_NAME = 'GRA6842';
const DEFAULT_COURSE_TITLE = 'Mastering Negotiation';
const DEFAULT_COURSE_TAGLINE = 'A space to rehearse, argue, and refine your negotiation thinking with an AI sparring partner.';

// Prompt cues — clickable suggestions shown above the chat input
const DEFAULT_PROMPT_CUES = JSON.stringify([
  { label: "What's my BATNA?", text: "What's my BATNA in this situation, and how strong is it?" },
  { label: "Where are we anchoring?", text: "Who has anchored the negotiation so far, and what's the effect of that anchor?" },
  { label: "What are their interests?", text: "Help me distinguish the other side's stated positions from their underlying interests." },
  { label: "Stress-test my move", text: "I'm thinking of making this move: [describe it]. What would the other side likely do in response?" },
  { label: "What am I missing?", text: "What blind spot or assumption am I probably making that I should examine?" },
  { label: "Reframe for me", text: "How might I reframe this conflict so both sides could see a path forward?" }
]);

// Stages — predefined phases of inquiry, each adds extra context to the system prompt.
// Stage with id "default" is what's used when no stage is selected. Others are admin-defined.
const DEFAULT_STAGES = JSON.stringify([
  {
    id: 'default',
    label: 'Open Inquiry',
    description: 'General Socratic conversation about the case or any negotiation question.',
    instruction: ''
  },
  {
    id: 'diagnose',
    label: 'Diagnose',
    description: 'Help the student map out the situation: parties, interests, positions, BATNAs, ZOPA.',
    instruction: 'For this stage, focus on helping the student DIAGNOSE the negotiation situation. Guide them to map out: (1) the parties involved, (2) each side\'s stated positions vs. underlying interests, (3) BATNAs, and (4) the likely ZOPA. Ask probing questions to surface missing information. Do not jump to strategy yet — stay in diagnostic mode.'
  },
  {
    id: 'strategize',
    label: 'Strategize',
    description: 'Once the situation is mapped, develop and stress-test concrete moves.',
    instruction: 'For this stage, the student has diagnosed the situation. Now help them STRATEGIZE: which moves to make, what to anchor with, when to concede, how to frame. For every move they propose, ask "What would the other side do in response?" Push them to consider second- and third-order effects.'
  },
  {
    id: 'reflect',
    label: 'Reflect',
    description: 'After a negotiation (real or hypothetical), help the student debrief.',
    instruction: 'For this stage, the student has just been through (or is debriefing) a negotiation. Help them REFLECT honestly. Ask: What surprised them? Where did they leave value on the table? What pattern do they see in their own behavior? Avoid empty affirmation — push for genuine self-examination.'
  }
]);

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, value, now());
}
function getJsonSetting(key, fallback) {
  try { return JSON.parse(getSetting(key, fallback)); }
  catch (e) { return JSON.parse(fallback); }
}

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

// Sentiment analysis: classify a student message into one of a few categories
// using a lightweight Gemini call. Runs asynchronously — doesn't block the chat reply.
const SENTIMENT_LABELS = ['curious', 'confident', 'confused', 'frustrated', 'engaged', 'reflective', 'skeptical', 'neutral'];

async function analyzeSentiment(messageId, text) {
  if (!GEMINI_API_KEY) return;
  if (!text || text.trim().length < 5) {
    // Too short to analyze meaningfully — mark as neutral
    db.prepare('UPDATE messages SET sentiment = ? WHERE id = ?').run('neutral', messageId);
    return;
  }
  try {
    const prompt = `Classify the emotional and cognitive tone of this student message in a negotiation course. Pick exactly ONE label from this list and reply with only that single word, lowercase, nothing else: ${SENTIMENT_LABELS.join(', ')}.

Student message: """${text.slice(0, 1500)}"""

Label:`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 10 }
      })
    });
    if (!res.ok) return;
    const data = await res.json();
    const raw = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').toLowerCase().trim();
    const label = SENTIMENT_LABELS.find(l => raw.includes(l)) || 'neutral';
    db.prepare('UPDATE messages SET sentiment = ? WHERE id = ?').run(label, messageId);
  } catch (err) {
    console.error('Sentiment analysis failed:', err.message);
  }
}


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
  // Template comes from settings, with {name} replaced by the student's first name
  const firstName = name.split(/\s+/)[0];
  const welcomeTemplate = getSetting('welcome_message', DEFAULT_WELCOME);
  const welcomeMessage = welcomeTemplate.replaceAll('{name}', firstName);

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
  const { message, case_id, stage_id } = req.body;
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

  // System prompt: from settings, configurable in admin UI
  const basePrompt = getSetting('system_prompt', DEFAULT_SYSTEM_PROMPT);
  let systemPrompt = basePrompt + `\n\nThe student's name is ${req.student.name}. Address them by name occasionally — it builds rapport.`;

  // Stage-specific instruction (if student is currently in a specific phase)
  if (stage_id && stage_id !== 'default') {
    const stages = getJsonSetting('stages', DEFAULT_STAGES);
    const stage = stages.find(s => s.id === stage_id);
    if (stage && stage.instruction) {
      systemPrompt += `\n\n--- CURRENT STAGE: ${stage.label.toUpperCase()} ---\n${stage.instruction}`;
    }
  }

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

    // Fire-and-forget: classify the student's message sentiment (doesn't block response)
    analyzeSentiment(userMsgId, message).catch(err => console.error('Sentiment bg task:', err.message));
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

// Students list — enriched with avg response time, learning span, conversation depth
app.get('/api/admin/students', authAdmin, (req, res) => {
  const students = db.prepare(`
    SELECT
      s.id, s.name, s.created_at, s.last_active,
      COALESCE(SUM(ss.duration_ms), 0) as total_duration_ms,
      (SELECT COUNT(*) FROM messages m WHERE m.student_id = s.id AND m.role='user') as prompt_count,
      (SELECT COUNT(*) FROM messages m WHERE m.student_id = s.id) as total_messages,
      (SELECT AVG(response_ms) FROM messages m WHERE m.student_id = s.id AND m.role='assistant' AND response_ms IS NOT NULL) as avg_response_ms,
      (SELECT MIN(created_at) FROM messages m WHERE m.student_id = s.id AND m.role='user') as first_prompt_at,
      (SELECT MAX(created_at) FROM messages m WHERE m.student_id = s.id AND m.role='user') as last_prompt_at
    FROM students s
    LEFT JOIN sessions ss ON ss.student_id = s.id
    GROUP BY s.id
    ORDER BY s.last_active DESC
  `).all();
  res.json({ students });
});

// All prompt records for a student (includes sentiment labels)
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

// Online students: anyone whose last_active was in the past 2 minutes
app.get('/api/admin/online', authAdmin, (req, res) => {
  const cutoff = now() - 2 * 60 * 1000;
  const rows = db.prepare(`
    SELECT id, name, last_active FROM students WHERE last_active >= ? ORDER BY last_active DESC
  `).all(cutoff);
  res.json({ online: rows, count: rows.length });
});

// Sentiment distribution across all student messages
app.get('/api/admin/sentiment', authAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT sentiment, COUNT(*) as count
    FROM messages
    WHERE role = 'user' AND sentiment IS NOT NULL
    GROUP BY sentiment
    ORDER BY count DESC
  `).all();
  const total = rows.reduce((s, r) => s + r.count, 0);
  res.json({ distribution: rows, total });
});

// Per-student sentiment breakdown (for the drawer view)
app.get('/api/admin/students/:id/sentiment', authAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT sentiment, COUNT(*) as count
    FROM messages
    WHERE student_id = ? AND role = 'user' AND sentiment IS NOT NULL
    GROUP BY sentiment
    ORDER BY count DESC
  `).all(req.params.id);
  res.json({ distribution: rows });
});

// Export a single student's full conversation log as Markdown
app.get('/api/admin/students/:id/export', authAdmin, (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const messages = db.prepare(`
    SELECT m.*, c.title as case_title
    FROM messages m
    LEFT JOIN cases c ON c.id = m.case_id
    WHERE m.student_id = ?
    ORDER BY m.created_at ASC
  `).all(req.params.id);

  const fmt = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  let md = `# Conversation Log — ${student.name}\n\n`;
  md += `- **Student ID:** ${student.id}\n`;
  md += `- **Joined:** ${fmt(student.created_at)}\n`;
  md += `- **Last active:** ${fmt(student.last_active)}\n`;
  md += `- **Total messages:** ${messages.length}\n`;
  md += `- **User prompts:** ${messages.filter(m => m.role === 'user').length}\n\n`;
  md += `---\n\n`;

  let lastCase = '__START__';
  for (const m of messages) {
    const caseLabel = m.case_title || '[free conversation]';
    if (caseLabel !== lastCase) {
      md += `\n## ${caseLabel}\n\n`;
      lastCase = caseLabel;
    }
    const role = m.role === 'user' ? student.name : 'Digital Robin';
    const sentiment = m.sentiment ? ` _(sentiment: ${m.sentiment})_` : '';
    const responseTime = m.response_ms ? ` _(${(m.response_ms / 1000).toFixed(1)}s)_` : '';
    md += `**${role}** · ${fmt(m.created_at)}${sentiment}${responseTime}\n\n`;
    md += m.content + '\n\n';
    md += `---\n\n`;
  }

  const safeName = student.name.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}_${student.id}.md"`);
  res.send(md);
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

// ───── Settings (configurable from admin UI) ─────
app.get('/api/admin/settings', authAdmin, (req, res) => {
  res.json({
    welcome_message: getSetting('welcome_message', DEFAULT_WELCOME),
    system_prompt: getSetting('system_prompt', DEFAULT_SYSTEM_PROMPT),
    brand_name: getSetting('brand_name', DEFAULT_COURSE_NAME),
    brand_title: getSetting('brand_title', DEFAULT_COURSE_TITLE),
    brand_tagline: getSetting('brand_tagline', DEFAULT_COURSE_TAGLINE),
    ai_name: getSetting('ai_name', 'Digital Robin'),
    prompt_cues: getJsonSetting('prompt_cues', DEFAULT_PROMPT_CUES),
    stages: getJsonSetting('stages', DEFAULT_STAGES),
    defaults: {
      welcome_message: DEFAULT_WELCOME,
      system_prompt: DEFAULT_SYSTEM_PROMPT,
      brand_name: DEFAULT_COURSE_NAME,
      brand_title: DEFAULT_COURSE_TITLE,
      brand_tagline: DEFAULT_COURSE_TAGLINE,
      ai_name: 'Digital Robin',
      prompt_cues: JSON.parse(DEFAULT_PROMPT_CUES),
      stages: JSON.parse(DEFAULT_STAGES),
    }
  });
});

app.post('/api/admin/settings', authAdmin, (req, res) => {
  const body = req.body;
  const strings = {
    welcome_message: 10000,
    system_prompt: 20000,
    brand_name: 60,
    brand_title: 120,
    brand_tagline: 300,
    ai_name: 60,
  };
  for (const [key, maxLen] of Object.entries(strings)) {
    if (typeof body[key] === 'string') {
      if (body[key].length > maxLen) return res.status(400).json({ error: `${key} is too long (max ${maxLen} chars)` });
      setSetting(key, body[key]);
    }
  }
  // prompt_cues — array of {label, text}
  if (Array.isArray(body.prompt_cues)) {
    const cleaned = body.prompt_cues
      .filter(c => c && typeof c.label === 'string' && typeof c.text === 'string' && c.label.trim() && c.text.trim())
      .slice(0, 20)
      .map(c => ({ label: c.label.trim().slice(0, 80), text: c.text.trim().slice(0, 600) }));
    setSetting('prompt_cues', JSON.stringify(cleaned));
  }
  // stages — array of {id, label, description, instruction}
  if (Array.isArray(body.stages)) {
    const cleaned = body.stages
      .filter(s => s && typeof s.label === 'string' && s.label.trim())
      .slice(0, 12)
      .map(s => ({
        id: (s.id || s.label).toString().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40) || 'stage',
        label: s.label.trim().slice(0, 60),
        description: (s.description || '').toString().trim().slice(0, 400),
        instruction: (s.instruction || '').toString().trim().slice(0, 4000),
      }));
    // Always keep a 'default' (open) stage as the first entry
    if (!cleaned.some(s => s.id === 'default')) {
      cleaned.unshift({ id: 'default', label: 'Open Inquiry', description: 'General Socratic conversation.', instruction: '' });
    }
    setSetting('stages', JSON.stringify(cleaned));
  }
  res.json({ ok: true });
});

// ───── Student-readable config (brand, cues, stages) ─────
// Lightweight endpoint students can hit without auth complications — exposes only display-safe fields
app.get('/api/config', (req, res) => {
  res.json({
    brand_name: getSetting('brand_name', DEFAULT_COURSE_NAME),
    brand_title: getSetting('brand_title', DEFAULT_COURSE_TITLE),
    brand_tagline: getSetting('brand_tagline', DEFAULT_COURSE_TAGLINE),
    ai_name: getSetting('ai_name', 'Digital Robin'),
    prompt_cues: getJsonSetting('prompt_cues', DEFAULT_PROMPT_CUES),
    stages: getJsonSetting('stages', DEFAULT_STAGES),
  });
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
