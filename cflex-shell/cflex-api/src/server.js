// ============================================================
// C-Flex FMS — Main API Server v2.1
// ============================================================

require("dotenv").config();
const express = require("express");
const cors    = require("cors");

require("./config/schema");

const { initAiSchema } = require("./config/ai-schema");
const db               = require("./config/database");
initAiSchema(db);

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || "*", credentials: true }));
app.use(express.json({
  limit: "50mb",
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

const { verifyToken, isolateTenant } = require("./middlewares/auth.middleware");
const autoRcaGate = require("./ai/auto-rca-gate");
// TASK B3: billing automation scheduler
try {
  require("./services/billing-automation").start();
} catch (e) { console.error("[billing-automation]", e.message); }

// TASK 8: runbook YAML → DB 동기화
try {
  const runbookEngine = require("./runbooks/runbook-engine");
  runbookEngine.syncToDb();
} catch (e) { console.error("[runbook-sync]", e.message); }
const resolveTenant                  = require("./middlewares/tenant.middleware");

const authRoutes        = require("./routes/auth.routes");
const ticketRoutes      = require("./routes/ticket.routes");
const slaRoutes         = require("./routes/sla.routes");
const billingRoutes     = require("./routes/billing.routes");
const telemetryRoutes   = require("./routes/telemetry.routes");
const predictionsRoutes = require("./routes/predictions.routes");
const aiRoutes          = require("./routes/ai.routes");
const aiExtendedRoutes  = require("./routes/ai-extended.routes");
const devicesRoutes     = require("./routes/devices.routes");
const networkRoutes     = require("./routes/network.routes");
const sbcRoutes         = require("./routes/sbc.routes");
const adminRoutes       = require("./routes/admin.routes");
const { startPoller: startUpsPoller } = require("./services/ups-poller");
const { startPoller: startNetworkPoller } = require("./services/network-poller");
const { startPoller: startSbcPoller } = require("./services/sbc-poller");

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "cflex-api-v2", version: "2.1.0", timestamp: new Date().toISOString() });
});

app.use("/v1/auth", authRoutes);

// === Dev identity (4002) replacement — v2 자체 처리 (no dev dependency) ===
const UserModel = require("./models/user.model");
const TenantModel = require("./models/tenant.model");
const MODULE_TO_PATH = {
  fms: "/fms", sentinel: "/sentinel", dealer: "/dealer", facility: "/facility",
  tickets: "/tickets", sla: "/sla", billing: "/billing", voice_ops: "/voice-ops",
  voice_workflow: "/voice-workflow", insights: "/insights", home: "/home",
  // Legacy SKU aliases (UPS/TEAMS/NETWORK/SBC live under /facility + /teams-phone)
  ups: "/facility", network: "/facility", sbc: "/facility", teams: "/teams-phone",
};
function computeLandingRoute(user, tenant) {
  const role = user?.role || "";
  if (role.startsWith("fms_")) return "/fms";
  if (role === "noc_operator") return "/sentinel";
  if (role.startsWith("dealer_")) return role === "dealer_sales" || role === "dealer_tech" ? "/tickets" : "/dealer";
  if (role === "super_admin" || role === "admin" || role === "oem_admin" || role === "engineer") return "/";
  const mods = Array.isArray(tenant?.sku) ? tenant.sku : [];
  const lc = mods.map(m => String(m).toLowerCase());
  if (lc.some(m => m === "sentinel" || m === "ebond" || m === "sentinel-connect" || m === "sc")) return "/sentinel";
  if (lc.some(m => m === "fms" || m === "ups" || m === "network" || m === "sbc")) return "/fms";
  if (lc.length > 0 && MODULE_TO_PATH[lc[0]]) return MODULE_TO_PATH[lc[0]];
  return "/home";
}

app.get("/v1/me", verifyToken, (req, res) => {
  const user = UserModel.findById(req.user.userId);
  if (!user) return res.status(404).json({ error: "user not found" });
  const tenant = user.tenant_id ? TenantModel.findById(user.tenant_id) : null;
  const skus = Array.isArray(tenant?.sku) ? tenant.sku : [];
  res.json({
    userId: user.id, email: user.email, displayName: user.name,
    role: user.role, persona: user.role,
    tenantId: user.tenant_id, tenantName: tenant ? tenant.display_name : null,
    tenant: tenant ? { id: tenant.id, name: tenant.subdomain || tenant.tenant_code,
                       display_name: tenant.display_name, status: tenant.status,
                       mode: tenant.mode, skus } : null,
    sku: skus,
    teamIds: [],
    landingRoute: computeLandingRoute(user, tenant),
  });
});
app.get("/v1/modules", verifyToken, (req, res) => res.json({ modules: [] }));


// ── v1 호환: /v1/tickets/auto (NOC poller → ticket 자동 생성) ──────
// 인증 면제 (내부 poller만 사용). dedupe by device_id + alert_metric.
// SNOW eBonding + Teams webhook 자동 동기화.
const http = require("http");
const https = require("https");
require("fs"); // ensure fs is in scope for future snow-config disk reads

function genTicketNo() {
  const yy = new Date().getFullYear();
  const seq = (db.prepare("SELECT COUNT(*) as c FROM tickets").get().c) + 1;
  return "CFX-" + yy + "-" + String(seq).padStart(5, "0");
}

function notifyTeamsWebhook(alert, ticketNo, action) {
  const url = process.env.TEAMS_WEBHOOK_URL;
  if (!url) return;
  try {
    const payload = JSON.stringify({
      "@type": "MessageCard",
      "@context": "https://schema.org/extensions",
      "themeColor": alert.priority === "P1" ? "EF4444" : alert.priority === "P2" ? "F59E0B" : "00909E",
      "summary": "C-Flex " + (action === "created" ? "Ticket Created" : "Update"),
      "title": "[" + alert.priority + "] " + (alert.label || alert.deviceId),
      "text": (action === "created" ? "🎫 Ticket " + ticketNo + " created" : "📝 Ticket " + ticketNo + " updated") +
              "\n**Site:** " + alert.site + "\n**Metric:** " + alert.metric + " = " + alert.value + " (threshold: " + alert.threshold + ")" +
              "\n**Health:** " + alert.healthScore + "/100\n" + alert.message,
    });
    const u = new URL(url);
    const opts = { host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "POST",
                   headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } };
    const req = (u.protocol === "https:" ? https : http).request(opts, () => {});
    req.on("error", e => console.warn("[teams] webhook error:", e.message));
    req.write(payload); req.end();
  } catch (e) { console.warn("[teams] webhook setup error:", e.message); }
}

// ServiceNow integration — entirely env-driven so a swap from the dev eBond
// bridge to the real ServiceNow Table API is a config-only change. Nothing
// SNOW-specific is hardcoded here besides the field-mapping contract (which
// is itself overridable via SNOW_FIELD_MAP_JSON).
const snowCfg = require('./services/snow-config').load();

function pushToSnow(ticket, action, opts2 = {}) {
  if (!snowCfg.enabled) return;
  const isCreate = action === 'created' || action === 'backfill';
  // For ebond updates: if the ticket already has an INC, send PATCH /incidents/{id}.
  // (POST /incidents on the dev gateway appends a duplicate row instead of upserting.)
  if (!isCreate && snowCfg.mode === 'ebond' && snowCfg.buildUpdate) {
    const fresh = db.prepare(`SELECT snow_incident FROM tickets WHERE id = ?`).get(ticket.id);
    const incId = fresh?.snow_incident;
    if (incId && /^INC/i.test(incId)) {
      const u = snowCfg.buildUpdate(ticket, incId, null, action);
      if (u) {
        const ulib = snowCfg.transport === 'https' ? https : http;
        const ureq = ulib.request(u.opts, (r) => {
          let b = ''; r.on('data', c => b += c); r.on('end', () => {
            const ok = u.parseResponse(b, r.statusCode);
            if (ok) console.log(`[snow:ebond] ${ticket.ticket_no} ↻ ${incId} PATCH (${action} · ${ticket.status})`);
            else console.warn(`[snow:ebond] ${ticket.ticket_no} PATCH ${incId} HTTP ${r.statusCode}: ${b.slice(0, 120)}`);
          });
        });
        ureq.on('error', e => console.warn(`[snow:ebond] PATCH error: ${e.message}`));
        ureq.on('timeout', () => ureq.destroy());
        ureq.write(u.payload); ureq.end();
        return;
      }
    }
    // No INC yet — fall through to create.
  }
  if (!opts2.force && !isCreate && snowCfg.mode === 'ebond') return;
  if (!opts2.force && isCreate) {
    const fresh = db.prepare(`SELECT snow_incident FROM tickets WHERE id = ?`).get(ticket.id);
    // Only skip if already linked to a real SNOW UI number (INC...). The dev
    // gateway's intermediate "CFX-EBOND-..." echo id is *not* the real
    // ServiceNow incident number, so a ticket linked only to that should be
    // re-pushed to obtain the proper INC.
    if (fresh?.snow_incident && /^INC/i.test(fresh.snow_incident)) return;
  }
  const { payload, opts, parseResponse } = snowCfg.buildPush(ticket, action);
  const lib = snowCfg.transport === 'https' ? https : http;
  const req = lib.request(opts, (r) => {
    let body = "";
    r.on("data", c => body += c);
    r.on("end", () => {
      try {
        const snowId = parseResponse(body, r.statusCode);
        if (snowId) {
          db.prepare("UPDATE tickets SET snow_incident=? WHERE id=?").run(snowId, ticket.id);
          console.log(`[snow:${snowCfg.mode}] ${ticket.ticket_no} → SNOW ${snowId} (${action})`);
          // dev eBond: the POST response carries the gateway's internal echo
          // id, not the real ServiceNow incident number. Follow up with
          // GET /incidents and try to find the INC by description match.
          if (snowCfg.mode === 'ebond') {
            setTimeout(() => relinkIncFromGateway(ticket), 600);
          }
        } else if (r.statusCode >= 400) {
          console.warn(`[snow:${snowCfg.mode}] ${ticket.ticket_no} HTTP ${r.statusCode}: ${body.slice(0, 160)}`);
        } else {
          console.warn(`[snow:${snowCfg.mode}] ${ticket.ticket_no} response had no id field: ${body.slice(0, 120)}`);
        }
      } catch (e) {
        console.warn(`[snow:${snowCfg.mode}] response parse failed for ${ticket.ticket_no}: ${e.message}`);
      }
    });
  });
  req.on("error", e => console.warn(`[snow:${snowCfg.mode}] ${ticket.ticket_no} error: ${e.message}`));
  req.on("timeout", () => req.destroy());
  req.write(payload); req.end();
}

// dev eBond only: the gateway's /incidents endpoint exposes both the real
// ServiceNow incident number ("id" = INCxxxxxxx) and the linked cflex ticket
// number ("cflex" = CFX-YYYY-NNNNN). Look it up after each push and rewrite
// tickets.snow_incident from the echo id to the real INC.
function relinkIncFromGateway(ticket) {
  if (snowCfg.mode !== 'ebond') return;
  const lib = snowCfg.transport === 'https' ? https : http;
  const opts = { host: snowCfg.host, port: snowCfg.port, path: '/incidents', method: 'GET', timeout: 6000,
                 headers: { Accept: 'application/json' } };
  const req = lib.request(opts, (r) => {
    let body = '';
    r.on('data', c => body += c);
    r.on('end', () => {
      try {
        const arr = JSON.parse(body);
        if (!Array.isArray(arr)) return;
        const hit = arr.find(x => x?.cflex === ticket.ticket_no && /^INC/i.test(x?.id || ''));
        if (hit) {
          db.prepare('UPDATE tickets SET snow_incident=? WHERE id=?').run(hit.id, ticket.id);
          console.log(`[snow:ebond] relinked ${ticket.ticket_no} → real SNOW ${hit.id}`);
        }
      } catch (_) {}
    });
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end();
}
global.cflexRelinkIncFromGateway = relinkIncFromGateway;

// Exposed for other modules (tvm-ticket.js, manual ticket creators).
global.cflexPushToSnow = pushToSnow;

// POST /v1/tickets/auto — 자동 ticket 생성 (poller 전용, no auth)
app.post("/v1/tickets/auto", express.json(), (req, res) => {
  const { alert, probeId } = req.body || {};
  if (!alert || !alert.deviceId || !alert.metric) {
    return res.status(400).json({ error: "alert with deviceId+metric required" });
  }
  // dedup by device + metric + status (open / in_progress)
  const existing = db.prepare(
    "SELECT id, ticket_no, priority FROM tickets WHERE device_id=? AND alert_metric=? AND status IN ('open','in_progress')"
  ).get(alert.deviceId, alert.metric);

  if (existing) {
    db.prepare("INSERT INTO ticket_notes (ticket_id, author, note, created_at) VALUES (?,?,?,?)")
      .run(existing.id, "C-Flex Auto", "Alert still active: " + (alert.message || "") + " (value: " + alert.value + ")", Date.now());
    db.prepare("UPDATE tickets SET updated_at=? WHERE id=?").run(Date.now(), existing.id);
    notifyTeamsWebhook(alert, existing.ticket_no, "updated");
    return res.json({ action: "updated", ticketNo: existing.ticket_no, id: existing.id });
  }

  const ticketNo = genTicketNo();
  const now = Date.now();
  const r = db.prepare(`INSERT INTO tickets
    (ticket_no, site, device_id, device_label, priority, domain, title, description,
     status, alert_metric, alert_value, alert_threshold, health_score, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    ticketNo, alert.site || null, alert.deviceId, alert.label || alert.deviceId,
    alert.priority || "P3", alert.domain || "UPS",
    "[" + (alert.priority || "P3") + "] " + (alert.label || alert.deviceId) + " — " + (alert.message || alert.metric),
    "Auto-generated by C-Flex FMS v2\nDevice: " + (alert.label || alert.deviceId) +
      "\nSite: " + (alert.site || "—") + "\nMetric: " + alert.metric + " = " + alert.value +
      " (threshold: " + (alert.threshold != null ? alert.threshold : "—") + ")\nHealth: " + (alert.healthScore || 0) + "/100",
    "open", alert.metric, alert.value, alert.threshold, alert.healthScore || 0, now, now
  );
  db.prepare("INSERT INTO ticket_notes (ticket_id, author, note, created_at) VALUES (?,?,?,?)")
    .run(r.lastInsertRowid, "C-Flex Auto", "Ticket auto-created\nProbe: " + (probeId || "unknown") + "\n" + (alert.message || ""), now);

  const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(r.lastInsertRowid);
  notifyTeamsWebhook(alert, ticketNo, "created");
  pushToSnow(ticket, "created");

  console.log("[ticket-auto] " + ticketNo + " created — " + alert.deviceId + " " + alert.metric + "=" + alert.value);

  // ── TASK 7: Auto-RCA fire-and-forget ──
  const priority = alert.priority || "P3";
  if (priority === "P1" || priority === "P2") {
    setImmediate(() => {
      autoRcaGate.maybeTriggerAuto(r.lastInsertRowid, priority, db, console).catch(e => console.error("[auto-rca] uncaught: " + e.message));
    });
  }

  res.json({ action: "created", ticketNo, id: r.lastInsertRowid });
});

// POST /v1/tickets/auto-resolve — state가 ok로 돌아오면 자동 resolve
app.post("/v1/tickets/auto-resolve", express.json(), (req, res) => {
  const { deviceId, metric, message } = req.body || {};
  if (!deviceId || !metric) return res.status(400).json({ error: "deviceId + metric required" });
  const open = db.prepare("SELECT id, ticket_no FROM tickets WHERE device_id=? AND alert_metric=? AND status IN ('open','in_progress')").get(deviceId, metric);
  if (!open) return res.json({ action: "noop", message: "no open ticket" });
  const now = Date.now();
  db.prepare("UPDATE tickets SET status='resolved', updated_at=?, resolved_at=? WHERE id=?").run(now, now, open.id);
  db.prepare("INSERT INTO ticket_notes (ticket_id, author, note, created_at) VALUES (?,?,?,?)")
    .run(open.id, "C-Flex Auto", "Auto-resolved — " + (message || "alert cleared"), now);
  console.log("[ticket-auto] " + open.ticket_no + " auto-resolved");
  res.json({ action: "resolved", ticketNo: open.ticket_no });
});



// ── Dashboard tenants — 본인 tenant만 (super_admin은 전체) — RBAC fix v1 ──
app.get("/v1/dashboard/tenants", verifyToken, isolateTenant, (req, res) => {
  try {
    const cols = `id, tenant_code, display_name, subdomain,
      branding_primary_color, branding_secondary_color,
      mode, parent_group, status, go_live_date, created_at, sku`;
    let rows;
    if (req.user.role === 'super_admin' || req.user.role === 'admin') {
      rows = db.prepare(`SELECT ${cols} FROM tenants ORDER BY parent_group NULLS LAST, display_name`).all();
    } else {
      rows = db.prepare(`SELECT ${cols} FROM tenants WHERE id = ?`).all(req.queryTenantId);
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/v1/dashboard/live-feed", verifyToken, isolateTenant, (req, res) => {
  try {
    const tid = req.queryTenantId;
    const isSuper = req.user.role === 'super_admin' || req.user.role === 'admin';
    let allowedSkus = null;
    if (!isSuper) {
      const tenant = db.prepare(`SELECT sku FROM tenants WHERE id = ?`).get(tid);
      if (!tenant) return res.status(403).json({ error: 'Tenant not found' });
      try {
        allowedSkus = typeof tenant.sku === 'string' ? JSON.parse(tenant.sku) : (tenant.sku || []);
      } catch { allowedSkus = (tenant.sku || '').split(',').map(s => s.trim()).filter(Boolean); }
    }
    const includeUps = !allowedSkus || allowedSkus.includes('UPS');
    const includeNet = !allowedSkus || allowedSkus.includes('NETWORK') || allowedSkus.includes('UPS');
    const includeSbc = !allowedSkus || allowedSkus.includes('TEAMS') || allowedSkus.includes('SBC');
    const includeUc  = !allowedSkus || allowedSkus.includes('TEAMS') || allowedSkus.includes('UC');
    const tFilter = (col) => isSuper ? '' : ` WHERE ${col} = ${parseInt(tid, 10)}`;
    const ups = includeUps ? db.prepare(`SELECT id,label,site,vendor,model,battery_pct,load_pct,temp_c,runtime_min,input_v,output_v,output_status,battery_status,status,health_score,last_polled FROM ups_devices${tFilter('tenant_id')}`).all().map(d => ({
      id: "UPS-" + d.id, label: d.label, site: d.site || "unknown",
      model: ((d.vendor || "") + " " + (d.model || "")).trim() || "UPS",
      battery: d.battery_pct, load: d.load_pct, temp: d.temp_c,
      runtime: d.runtime_min, inputV: d.input_v, outputV: d.output_v,
      outputStatus: d.output_status, batteryStatus: d.battery_status,
      status: d.status, healthScore: d.health_score, ts: d.last_polled || Date.now(),
    })) : [];
    const network = includeNet ? db.prepare(`SELECT id,label,site,cpu_pct,mem_pct,packet_loss_pct,throughput_mbps,if_total,if_up,if_down,status,health_score,last_polled FROM network_devices${tFilter('tenant_id')}`).all().map(d => ({
      id: "NET-" + d.id, label: d.label, site: d.site || "unknown",
      cpu: d.cpu_pct, mem: d.mem_pct, loss: d.packet_loss_pct,
      throughput: d.throughput_mbps, ifTotal: d.if_total, ifUp: d.if_up, ifDown: d.if_down,
      status: d.status, healthScore: d.health_score, ts: d.last_polled || Date.now(),
    })) : [];
    const sbc = includeSbc ? db.prepare(`SELECT id,label,site,active_calls,max_calls,utilization_pct,trunks_total,trunks_down,cpu_pct,mem_pct,registrations,calls_per_sec,media_loss_pct,dsp_usage_pct,status,health_score,last_polled FROM sbc_devices${tFilter('tenant_id')}`).all().map(d => ({
      id: "SBC-" + d.id, label: d.label, site: d.site || "unknown",
      activeCalls: d.active_calls, maxCalls: d.max_calls, utilization: d.utilization_pct,
      trunksTotal: d.trunks_total, trunksDown: d.trunks_down, cpu: d.cpu_pct, mem: d.mem_pct,
      registrations: d.registrations, callsPerSec: d.calls_per_sec,
      mediaLoss: d.media_loss_pct, dspUsage: d.dsp_usage_pct,
      status: d.status, healthScore: d.health_score, ts: d.last_polled || Date.now(),
    })) : [];
    const ucQos = includeUc ? (() => {
      const ucRows = db.prepare(`SELECT platform,site,mos,jitter_ms,packet_loss_pct,round_trip_ms,received_at FROM uc_qos${tFilter('tenant_id')} ORDER BY received_at DESC LIMIT 50`).all();
      return {
        hasData: ucRows.length > 0,
        recent: ucRows.map(r => ({
          platform: r.platform, site: r.site,
          mos: r.mos, jitter: r.jitter_ms, loss: r.packet_loss_pct, rtt: r.round_trip_ms,
          ts: r.received_at,
        })),
      };
    })() : { hasData: false, recent: [] };
    res.json({ ts: Date.now(), ups, network, sbc, ucQos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/v1/dashboard/telemetry", verifyToken, isolateTenant, (req, res) => {
  try {
    const tid = req.queryTenantId;
    const isSuper = req.user.role === 'super_admin' || req.user.role === 'admin';
    const devs = isSuper
      ? db.prepare("SELECT * FROM ups_devices").all()
      : db.prepare("SELECT * FROM ups_devices WHERE tenant_id = ?").all(parseInt(tid, 10));
    const out = devs.map(d => ({
      id: d.id,
      probe_id: "ups-poller",
      device_id: "UPS-" + d.id,
      site: d.site || "unknown",
      label: d.label,
      received_at: d.last_polled || d.updated_at,
      data: {
        deviceId: "UPS-" + d.id,
        label: d.label,
        site: d.site || "unknown",
        model: ((d.vendor || "") + " " + (d.model || "")).trim() || "UPS",
        ip: d.ip,
        domain: "UPS",
        battery: d.battery_pct,
        load: d.load_pct,
        temp: d.temp_c,
        runtime: d.runtime_min,
        inputV: d.input_v,
        outputV: d.output_v,
        outputStatus: d.output_status,
        batteryStatus: d.battery_status,
        status: d.status,
        healthScore: d.health_score,
        consecutiveFails: d.consecutive_fails,
        _scannedSecondsAgo: d.last_polled ? Math.round((Date.now() - d.last_polled) / 1000) : null,
      },
    }));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



const scope = [verifyToken, isolateTenant, resolveTenant];
app.use("/v1/tickets",     ...scope, ticketRoutes);
app.use("/v1/sla",         ...scope, slaRoutes);
app.use("/v1/sla",        verifyToken, require("./routes/sla-restructure.routes"));
app.use("/v1/agent",      verifyToken, require("./routes/agent.routes"));
app.use("/v1/integrations/teams", require("./routes/integrations-teams.routes"));  // NO verifyToken — Bot Framework auth in adapter
app.use("/v1/integrations/slack", require("./routes/integrations-slack.routes"));  // NO verifyToken — Slack signs requests
app.use("/v1", require("./routes/m365.routes"));  // M365 SSO (admin config + auth flow)
app.use("/v1/onboarding/apc", verifyToken, require("./routes/apc-onboarding.routes"));
app.use("/v1/ups/onboard", verifyToken, require("./routes/ups-onboarding.routes"));
// Probe-facing endpoints — the probeAuth middleware in the route handles X-Probe-Key,
// admin endpoints inside use req.user from optional verifyToken. We mount with verifyToken
// but allow probe-key paths to bypass via internal check.
app.use("/v1/sentinel", verifyToken, require("./routes/sentinel.routes"));
app.use("/v1/fms", verifyToken, require("./routes/fms.routes"));
app.use("/v1/fms", verifyToken, require("./routes/fms-push.routes"));

// ── TVM (Technical Vulnerability Management) ─────────────
// ingestRouter must be mounted BEFORE the JWT-protected router so the
// scanner systemd timer can POST with HMAC instead of a bearer token.
{
  const tvm = require("./routes/tvm.routes");
  app.use("/v1/tvm", tvm.ingestRouter);
  app.use("/v1/tvm", tvm.router);
}
require("./services/tvm-sla-watcher").start();
require("./services/defender-ti-poller").start();
try { require("./services/security-event-ingest").start(); }
catch (e) { console.warn("[sec-event] startup error:", e.message); }
require("./services/snow-poller").start();

// SNOW backfill — push every cflex ticket without a snow_incident link.
// Idempotent: re-running it doesn't duplicate incidents because pushToSnow
// itself short-circuits when ticket.snow_incident is already set.
app.post("/v1/admin/snow/backfill", verifyToken, async (req, res) => {
  if (req.user?.role !== "super_admin" && req.user?.role !== "admin") {
    return res.status(403).json({ error: "super_admin or admin required" });
  }
  const limit = Math.min(parseInt(req.body?.limit, 10) || 500, 5000);
  const dryRun = !!req.body?.dryRun;
  try {
    const r = await require("./services/snow-poller").backfillUnlinked({ limit, dryRun });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Walk the gateway /incidents list and link every cflex ticket whose
// description shows up in there. Used to upgrade existing CFX-EBOND-XXXX
// echoes to real INC numbers without re-pushing.
app.post("/v1/admin/snow/relink-incs", verifyToken, async (req, res) => {
  if (req.user?.role !== "super_admin" && req.user?.role !== "admin") {
    return res.status(403).json({ error: "super_admin or admin required" });
  }
  try {
    const lib = snowCfg.transport === 'https' ? https : http;
    const arr = await new Promise((resolve, reject) => {
      const r = lib.request({ host: snowCfg.host, port: snowCfg.port, path: '/incidents', method: 'GET', timeout: 8000,
                              headers: { Accept: 'application/json' } }, (rs) => {
        let body = ''; rs.on('data', c => body += c);
        rs.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout'))); r.end();
    });
    let updated = 0, scanned = Array.isArray(arr) ? arr.length : 0;
    const stmt = db.prepare('UPDATE tickets SET snow_incident=? WHERE id=?');
    for (const inc of (arr || [])) {
      if (!inc?.id || !/^INC/i.test(inc.id)) continue;
      // Gateway exposes the linked cflex ticket on the "cflex" key.
      const tn = inc.cflex;
      if (!tn || !/^CFX-\d{4}-/.test(tn)) continue;
      const row = db.prepare('SELECT id, snow_incident FROM tickets WHERE ticket_no=?').get(tn);
      if (row && row.snow_incident !== inc.id) { stmt.run(inc.id, row.id); updated++; }
    }
    res.json({ ok: true, scanned, updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Force-run one poll cycle right now (bypasses 15s interval). Used by the
// frontend Refresh button to sync state both ways on demand.
app.post("/v1/snow/sync-now", verifyToken, async (req, res) => {
  try {
    const r = await require("./services/snow-poller").pollOnce();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/v1/admin/snow/status", verifyToken, (req, res) => {
  const total  = db.prepare(`SELECT COUNT(*) AS n FROM tickets`).get().n;
  const linked = db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE snow_incident IS NOT NULL`).get().n;
  const recent = db.prepare(`SELECT ticket_no, priority, domain, status, snow_incident FROM tickets WHERE snow_incident IS NOT NULL ORDER BY id DESC LIMIT 10`).all();
  const poller = require("./services/snow-poller");
  res.json({
    ok: true, total, linked, unlinked: total - linked,
    link_pct: total ? Math.round(linked / total * 100) : 0,
    mode: poller.mode, poll_ms: poller.pollMs,
    recent,
  });
});

// Inbound webhook from ServiceNow (Business Rule / Outbound REST Step).
// Pre-shared SNOW_WEBHOOK_SECRET — set in cflex .env and configured in SNOW.
// Updates the linked cflex ticket immediately (no 30s wait for poll).
//
// Body shape (controlled by the SNOW Business Rule):
//   { secret, correlation_id, state, priority, assigned_to, work_notes, number, sys_id }
// state values are SNOW state codes; correlation_id == cflex ticket_no.
app.post("/v1/snow/webhook/inbound", express.json(), (req, res) => {
  const secret = process.env.SNOW_WEBHOOK_SECRET;
  if (secret && req.body?.secret !== secret) return res.status(401).json({ error: "bad secret" });
  const r = req.body || {};
  const cflexTicketNo = r.correlation_id || r.u_cflex_ticket_no || r.cflex_ticket_no;
  if (!cflexTicketNo) return res.status(400).json({ error: "correlation_id (cflex ticket_no) required" });
  try {
    const result = require("./services/snow-poller").applyOne({
      cflex_ticket_no: cflexTicketNo,
      // The poller's applyOne expects pre-normalised status; we pass through
      // snowCfg.statusMapInbound mapping inline here.
      status: snowCfg.statusMapInbound?.[String(r.state)] || r.status || null,
      priority: r.priority,
      assignee: typeof r.assigned_to === 'object' ? r.assigned_to?.display_value : r.assigned_to,
      work_notes: r.work_notes,
      snow_id: r.number || r.sys_id,
    });
    res.json({ ok: true, ...(result || {}) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.use("/v1/probe", (req, res, next) => {
  // probeAuth paths use X-Probe-Key; admin paths require JWT
  if (req.headers['x-probe-key']) return next();
  return verifyToken(req, res, next);
}, require("./routes/probe.routes"));
app.use("/v1", verifyToken, isolateTenant, require("./routes/modules.routes"));
app.use("/v1/billing",     ...scope, billingRoutes);
app.use("/v1/billing",    verifyToken, require("./routes/billing-reports.routes"));
app.use("/v1/telemetry",   ...scope, telemetryRoutes);
app.use("/v1/predictions", ...scope, predictionsRoutes);
app.use("/v1/ai",          ...scope, aiRoutes);
app.use("/v1/ai",          ...scope, aiExtendedRoutes);
app.use("/v1/devices",     ...scope, devicesRoutes);
app.use("/v1/devices",     ...scope, networkRoutes);
app.use("/v1/devices",     ...scope, sbcRoutes);
// ── TASK 7: Auto-RCA admin endpoints (super_admin) ──
app.get("/v1/admin/auto-rca-state", verifyToken, (req, res) => {
  if (req.user?.role !== "super_admin") return res.status(403).json({ error: "super_admin required" });
  res.json({ ok: true, state: autoRcaGate.getState(), usage: autoRcaGate.getUsageSummary(db) });
});

app.post("/v1/admin/auto-rca-toggle", verifyToken, express.json(), (req, res) => {
  if (req.user?.role !== "super_admin") return res.status(403).json({ error: "super_admin required" });
  const { enabled, hours } = req.body || {};
  const state = autoRcaGate.setEnabled(enabled, hours, req.user.email);
  res.json({ ok: true, state });
});

app.patch("/v1/admin/auto-rca-caps", verifyToken, express.json(), (req, res) => {
  if (req.user?.role !== "super_admin") return res.status(403).json({ error: "super_admin required" });
  const { daily_usd, monthly_usd, rate_per_min, max_session_hours } = req.body || {};
  const updates = {};
  if (daily_usd != null) updates.daily_usd = parseFloat(daily_usd);
  if (monthly_usd != null) updates.monthly_usd = parseFloat(monthly_usd);
  if (rate_per_min != null) updates.rate_per_min = parseInt(rate_per_min, 10);
  if (max_session_hours != null) updates.max_session_hours = parseFloat(max_session_hours);
  const state = autoRcaGate.setCaps(updates, req.user.email);
  res.json({ ok: true, state });
});

app.use("/v1/admin",       ...scope, adminRoutes);
app.use("/v1/runbooks",   verifyToken, require("./routes/runbook.routes"));
app.use("/v1/demo", verifyToken, require("./routes/demo.routes"));

const { errorHandler, notFound } = require("./middlewares/error.middleware");
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
startUpsPoller();
startNetworkPoller();
startSbcPoller();
require("./services/local-probe-runner").start();
require("./services/fms-report-scheduler").startFmsReportScheduler();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n========================================`);
  console.log(`  C-Flex FMS API v2.1  |  Port: ${PORT}`);
  console.log(`========================================\n`);
});
module.exports = app;
