// ============================================================
// C-Flex Sentinel — LLM Operations Copilot
// Standalone API on VM1:3300, proxied at sentinel.runless.co.uk/v1/agent/*
//
// Endpoints:
//   POST /v1/agent/sentinel/converse  (SSE) — main chat loop
//   GET  /v1/agent/sentinel/threads   — list conversations
//   GET  /v1/agent/sentinel/threads/:id — single thread + messages
//   POST /v1/agent/sentinel/threads   — new thread
//
// JWT verified locally against shared JWT_SECRET (no cross-VM calls).
// ============================================================

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const jwt     = require("jsonwebtoken");
const Database= require("better-sqlite3");
const Anthropic = require("@anthropic-ai/sdk").default;

const DB_PATH = process.env.SENTINEL_DB_PATH || "/opt/cflex-sentinel-api/data/sentinel.db";
const FMS_DB  = process.env.FMS_DB_PATH || "/opt/cflex-fms/data/fms.db";  // shared FMS DB for tool lookups
const PORT    = process.env.PORT || 3300;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

if (!ANTHROPIC_API_KEY) console.warn("[sentinel] ANTHROPIC_API_KEY not set — agent calls will fail");
if (!JWT_SECRET) { console.error("[sentinel] JWT_SECRET required"); process.exit(1); }

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY || "missing" });

// ── DB: thread + message store ─────────────────────────────────
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS sentinel_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    title TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_threads_user ON sentinel_threads(user_id, updated_at);

  CREATE TABLE IF NOT EXISTS sentinel_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    role TEXT NOT NULL,            -- user | assistant | tool_use | tool_result
    content TEXT NOT NULL,         -- JSON-encoded
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_msg_thread ON sentinel_messages(thread_id, id);

  CREATE TABLE IF NOT EXISTS sentinel_tool_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    input TEXT,
    output TEXT,
    ok INTEGER,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL
  );
`);

// Shared read-only DB connection for tool execution (FMS data)
let fmsDb = null;
try { fmsDb = new Database(FMS_DB, { readonly: true, fileMustExist: true }); }
catch (e) { console.warn("[sentinel] fms DB not accessible (readonly):", e.message); }

// ── Express setup ──────────────────────────────────────────────
const app = express();
app.use(cors({ origin: "*", credentials: false }));
app.use(express.json({ limit: "1mb" }));

function verifyJwt(req, res, next) {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: "missing token" });
  try { req.user = jwt.verify(tok, JWT_SECRET); next(); }
  catch (e) { return res.status(401).json({ error: "invalid token" }); }
}

// ── Tool registry ──────────────────────────────────────────────
const TOOLS = [
  {
    name: "query_alarms",
    description: "List facility alarms (UPS, network, SBC, etc.) for the current tenant. Returns the latest matching alarms with id, device_id, priority, metric, message, value, threshold, received_at, acked_at.",
    input_schema: {
      type: "object",
      properties: {
        priority: { type: "string", enum: ["P1","P2","P3","P4"], description: "Optional severity filter" },
        unacked_only: { type: "boolean", description: "Only return alarms that have not been acknowledged yet" },
        hours: { type: "integer", description: "Look back this many hours (default 24)" },
        limit: { type: "integer", description: "Max rows to return (default 20, max 100)" },
      },
    },
  },
  {
    name: "query_tickets",
    description: "Search facility tickets by status, priority, or device. Returns ticket id, title, priority, status, created_at, assignee.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional: open / in_progress / closed" },
        priority: { type: "string", enum: ["P1","P2","P3","P4"] },
        limit: { type: "integer", description: "Max rows (default 10)" },
      },
    },
  },
  {
    name: "create_ticket",
    description: "Create a facility ticket linked to an alarm. Requires an alarm id and short summary. The created ticket is returned with its number.",
    input_schema: {
      type: "object",
      required: ["alert_id", "summary"],
      properties: {
        alert_id: { type: "integer", description: "Source alarm id from query_alarms" },
        summary:  { type: "string",  description: "1-line ticket title" },
        priority: { type: "string", enum: ["P1","P2","P3","P4"], description: "Defaults to the alarm priority" },
      },
    },
  },
  {
    name: "query_devices",
    description: "List UPS / network / SBC devices the current tenant operates. Returns id, label, location, status.",
    input_schema: {
      type: "object",
      properties: {
        site:   { type: "string", description: "Optional location filter (substring match)" },
        status: { type: "string", description: "Optional: ok / warn / critical / unreachable" },
        limit:  { type: "integer", description: "Max rows (default 30)" },
      },
    },
  },
  {
    name: "send_message",
    description: "Send an operations message via Slack, Teams, or SMS to a registered route in the current tenant's notification channels. Used for ack/escalation/handoff.",
    input_schema: {
      type: "object",
      required: ["channel", "text"],
      properties: {
        channel: { type: "string", enum: ["slack","teams","sms","line"], description: "Which channel" },
        text:    { type: "string", description: "Message body (≤ 320 chars for SMS)" },
      },
    },
  },
];

// ── Tool implementations ───────────────────────────────────────
function runQueryAlarms(args, ctx) {
  if (!fmsDb) return { error: "FMS database not accessible" };
  const hours = Math.min(Math.max(parseInt(args.hours || 24, 10), 1), 720);
  const limit = Math.min(parseInt(args.limit || 20, 10), 100);
  const cutoff = Date.now() - hours * 3600 * 1000;
  let sql = "SELECT id, device_id, priority, metric, message, value, threshold, received_at, acked_at, acked_by FROM alerts WHERE tenant_id=? AND received_at>?";
  const p = [ctx.tenantId, cutoff];
  if (args.priority) { sql += " AND priority=?"; p.push(args.priority); }
  if (args.unacked_only) { sql += " AND acked_at IS NULL"; }
  sql += " ORDER BY received_at DESC LIMIT ?";
  p.push(limit);
  const rows = fmsDb.prepare(sql).all(...p);
  return { count: rows.length, alarms: rows };
}
function runQueryTickets(args, ctx) {
  if (!fmsDb) return { error: "FMS database not accessible" };
  const limit = Math.min(parseInt(args.limit || 10, 10), 50);
  let sql = "SELECT id, priority, status, message AS title, received_at, acked_at FROM alerts WHERE tenant_id=? AND ticket_id IS NOT NULL";
  const p = [ctx.tenantId];
  if (args.priority) { sql += " AND priority=?"; p.push(args.priority); }
  sql += " ORDER BY received_at DESC LIMIT ?";
  p.push(limit);
  const rows = fmsDb.prepare(sql).all(...p);
  return { count: rows.length, tickets: rows };
}
function runCreateTicket(args, ctx) {
  return { ok: false, error: "Ticket creation is read-only in this preview. Use the FMS UI to create tickets." };
}
function runQueryDevices(args, ctx) {
  if (!fmsDb) return { error: "FMS database not accessible" };
  const limit = Math.min(parseInt(args.limit || 30, 10), 200);
  let sql = "SELECT id, label, location, room, rack FROM ups_devices WHERE tenant_id=?";
  const p = [ctx.tenantId];
  if (args.site) { sql += " AND (location LIKE ? OR room LIKE ?)"; p.push("%"+args.site+"%", "%"+args.site+"%"); }
  sql += " ORDER BY id LIMIT ?";
  p.push(limit);
  const rows = fmsDb.prepare(sql).all(...p);
  return { count: rows.length, devices: rows };
}
function runSendMessage(args, ctx) {
  return { ok: false, error: "Send is in preview mode — message logged but not dispatched. Wire to alarm-notifier in next phase." };
}

const TOOL_IMPL = {
  query_alarms:  runQueryAlarms,
  query_tickets: runQueryTickets,
  create_ticket: runCreateTicket,
  query_devices: runQueryDevices,
  send_message:  runSendMessage,
};

const SYSTEM_PROMPT = `You are the C-Flex Sentinel — an AI Operations Copilot for facility, voice, and customer-messaging incidents.

Your job: help operators investigate alarms, triage tickets, find devices, and coordinate response across teams (Slack/Teams/SMS).

Use the tools provided to fetch real data. Don't hallucinate alarm ids, device ids, or counts. If you don't have a tool for something, say so and suggest an alternative.

Respond in the same language the operator uses (Korean or English). Be concise — operators are busy. Use markdown tables for lists of more than 3 rows. When you take an action with a tool, say what you did and what you found.

Current operator context: tenant_id=<TENANT_ID>, role=<ROLE>.`;

// ── Thread management ─────────────────────────────────────────
app.get("/v1/agent/sentinel/threads", verifyJwt, (req, res) => {
  const rows = db.prepare("SELECT id, title, created_at, updated_at FROM sentinel_threads WHERE user_id=? ORDER BY updated_at DESC LIMIT 50").all(req.user.userId);
  res.json({ ok: true, threads: rows });
});
app.post("/v1/agent/sentinel/threads", verifyJwt, (req, res) => {
  const r = db.prepare("INSERT INTO sentinel_threads (tenant_id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run(req.user.tenantId || 0, req.user.userId, req.body?.title || "New conversation", Date.now(), Date.now());
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.get("/v1/agent/sentinel/threads/:id", verifyJwt, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = db.prepare("SELECT * FROM sentinel_threads WHERE id=? AND user_id=?").get(id, req.user.userId);
  if (!t) return res.status(404).json({ error: "not found" });
  const msgs = db.prepare("SELECT id, role, content, created_at FROM sentinel_messages WHERE thread_id=? ORDER BY id").all(id);
  res.json({ ok: true, thread: t, messages: msgs.map(m => ({ ...m, content: safeParse(m.content) })) });
});

function safeParse(s) { try { return JSON.parse(s); } catch { return s; } }

// ── Main SSE chat endpoint ────────────────────────────────────
app.post("/v1/agent/sentinel/converse", verifyJwt, async (req, res) => {
  let { thread_id, user_message } = req.body || {};
  if (!user_message || !user_message.trim()) return res.status(400).json({ error: "user_message required" });

  // Create thread on the fly if none
  if (!thread_id) {
    const r = db.prepare("INSERT INTO sentinel_threads (tenant_id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run(req.user.tenantId || 0, req.user.userId, user_message.slice(0, 60), Date.now(), Date.now());
    thread_id = r.lastInsertRowid;
  } else {
    const t = db.prepare("SELECT id FROM sentinel_threads WHERE id=? AND user_id=?").get(thread_id, req.user.userId);
    if (!t) return res.status(404).json({ error: "thread not found" });
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  sse("thread", { thread_id });

  // Persist user msg
  db.prepare("INSERT INTO sentinel_messages (thread_id, role, content, created_at) VALUES (?,?,?,?)")
    .run(thread_id, "user", JSON.stringify(user_message), Date.now());

  // Build conversation history for Anthropic — when an assistant turn contains
  // tool_use blocks, we must immediately follow it with a user message holding
  // tool_result blocks for every tool_use id. Rehydrate from sentinel_tool_log.
  const prior = db.prepare("SELECT role, content FROM sentinel_messages WHERE thread_id=? ORDER BY id").all(thread_id);
  const toolLogs = db.prepare("SELECT output FROM sentinel_tool_log WHERE thread_id=? ORDER BY id").all(thread_id);
  let logIdx = 0;
  const msgs = [];
  for (const r of prior) {
    const c = safeParse(r.content);
    if (r.role === "user") {
      msgs.push({ role: "user", content: typeof c === "string" ? c : JSON.stringify(c) });
    } else if (r.role === "assistant") {
      msgs.push({ role: "assistant", content: c });
      const toolUses = Array.isArray(c) ? c.filter(b => b && b.type === "tool_use") : [];
      if (toolUses.length > 0) {
        const results = toolUses.map(tu => {
          const log = toolLogs[logIdx++] || {};
          let output = log.output;
          try { output = JSON.parse(output); } catch (_) {}
          return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(output != null ? output : { error: "no log" }) };
        });
        msgs.push({ role: "user", content: results });
      }
    }
  }

  const systemPrompt = SYSTEM_PROMPT
    .replace("<TENANT_ID>", String(req.user.tenantId || "n/a"))
    .replace("<ROLE>", String(req.user.role || "n/a"));

  try {
    let iterations = 0;
    while (iterations++ < 8) {
      const resp = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        tools: TOOLS,
        messages: msgs,
      });

      const assistantContent = resp.content;
      // Persist this assistant turn
      db.prepare("INSERT INTO sentinel_messages (thread_id, role, content, created_at) VALUES (?,?,?,?)")
        .run(thread_id, "assistant", JSON.stringify(assistantContent), Date.now());

      // Stream out text blocks + tool_use blocks
      for (const block of assistantContent) {
        if (block.type === "text") sse("text", { text: block.text });
        if (block.type === "tool_use") sse("tool_use", { id: block.id, name: block.name, input: block.input });
      }

      msgs.push({ role: "assistant", content: assistantContent });

      if (resp.stop_reason !== "tool_use") break;

      // Execute tool calls in parallel, collect tool_result blocks
      const toolUseBlocks = assistantContent.filter(b => b.type === "tool_use");
      const toolResults = [];
      for (const tu of toolUseBlocks) {
        const fn = TOOL_IMPL[tu.name];
        const start = Date.now();
        let out;
        if (!fn) out = { error: `unknown tool: ${tu.name}` };
        else {
          try { out = fn(tu.input || {}, req.user); }
          catch (e) { out = { error: e.message }; }
        }
        const ms = Date.now() - start;
        db.prepare("INSERT INTO sentinel_tool_log (thread_id, tool_name, input, output, ok, duration_ms, created_at) VALUES (?,?,?,?,?,?,?)")
          .run(thread_id, tu.name, JSON.stringify(tu.input || {}), JSON.stringify(out), out.error ? 0 : 1, ms, Date.now());
        sse("tool_result", { tool_use_id: tu.id, name: tu.name, output: out, duration_ms: ms });
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
      }
      msgs.push({ role: "user", content: toolResults });
      // Loop again for next assistant turn
    }

    db.prepare("UPDATE sentinel_threads SET updated_at=? WHERE id=?").run(Date.now(), thread_id);
    sse("done", { thread_id });
    res.end();
  } catch (e) {
    console.error("[sentinel/converse]", e.message);
    sse("error", { message: e.message });
    res.end();
  }
});

app.get("/health", (req, res) => res.json({
  status: "ok", service: "cflex-sentinel-api", version: "0.1.0",
  anthropic_key_set: !!ANTHROPIC_API_KEY,
  tools_count: TOOLS.length,
}));

app.listen(PORT, () => {
  console.log(`\n[sentinel-api] listening on :${PORT}  · tools=${TOOLS.length}  · model=claude-sonnet-4-6`);
});
