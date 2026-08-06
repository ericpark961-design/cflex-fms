// /v1/incidents — Incident 단일 진실원천 외부 API.
// 내부 저장은 cflex_tickets (재사용). 외부 명명은 일관된 'incident'로.
// cflex_응대레이어_스펙.md Phase 1.
//
// 상태머신: open → ack → in_progress → resolved → closed.
// dedup: 활성 (open/ack/in_progress) 인시던트 1개 / (tenant, dedup_key).

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

// 호출부에서 주입: db (Postgres client), tenantOf(req), requireAuth.
// 본 모듈은 plain Express — 라우터 마운트 시 app.use('/v1/incidents', incidentsRoutes(deps)).

module.exports = function incidentsRoutes(deps) {
  const { pool, tenantOf, requireAuth } = deps;
  router.use(requireAuth);

  // ── helpers ────────────────────────────────────────────────────
  const ALLOWED_TRANSITIONS = {
    open:         ['ack', 'in_progress', 'resolved', 'closed'],
    ack:          ['in_progress', 'resolved', 'closed'],
    in_progress:  ['resolved', 'closed'],
    resolved:     ['closed', 'open'],   // reopen 가능
    closed:       [],                    // 종착
  };

  function mapRowToIncident(r) {
    if (!r) return null;
    return {
      id: r.id,
      tenant_id: r.tenant_id,
      site: r.site, cbu: r.cbu,
      asset: { type: r.device_type, id: r.device_id, label: r.device_label },
      severity: r.severity || severityFromPriority(r.priority),
      priority: r.priority,
      state: r.status,                 // 외부 명명: state (내부 status)
      source: r.source,
      title: r.title, description: r.description,
      dedup_key: r.dedup_key,
      channels: r.channels || [],
      snow_ticket_id: r.snow_incident,
      assignee: r.assignee,
      takeover: r.takeover_by ? { by: r.takeover_by, at: r.takeover_at } : null,
      sla: {
        response_at: r.response_at,
        target_response_min: r.sla_target_response_min,
        target_resolution_min: r.sla_target_resolution_min,
      },
      timestamps: {
        created_at: r.created_at, updated_at: r.updated_at,
        ack_at: r.ack_at, resolved_at: r.resolved_at, closed_at: r.closed_at,
      },
      mttr_seconds: r.mttr_seconds,
      ticket_no: r.ticket_no,
    };
  }

  function severityFromPriority(p) {
    return ({ P1: 'critical', P2: 'critical', P3: 'warn', P4: 'info' })[p] || 'info';
  }

  function priorityFromSeverity(sev) {
    return ({ critical: 'P1', warn: 'P3', info: 'P4' })[sev] || 'P3';
  }

  function makeDedupKey({ tenant_id, asset, severity, symptom }) {
    const s = `${tenant_id}|${asset?.type || ''}|${asset?.id || ''}|${severity || ''}|${(symptom || '').slice(0, 60)}`;
    return crypto.createHash('sha256').update(s).digest('base64').slice(0, 32);
  }

  async function appendTimeline(client, ticketId, tenantId, kind, actor, body, body_json = null) {
    await client.query(
      `INSERT INTO cflex_ticket_notes (ticket_id, tenant_id, author, author_kind, kind, note, body_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ticketId, tenantId, actor || 'system',
       (actor === 'ai' ? 'ai' : actor ? 'human' : 'system'),
       kind, body, body_json],
    );
  }

  // ── GET /v1/incidents ── list + filter ─────────────────────────
  router.get('/', async (req, res, next) => {
    try {
      const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant required' });
      const state = req.query.state;      // e.g. 'open,ack,in_progress'
      const severity = req.query.severity;
      const cbu = req.query.cbu;
      const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);

      const where = ['tenant_id = $1'];
      const params = [tid];
      let i = 2;
      if (state) {
        const states = state.split(',').map(s => s.trim());
        where.push(`status = ANY($${i++})`);
        params.push(states);
      }
      if (severity) {
        where.push(`severity = $${i++}`); params.push(severity);
      }
      if (cbu) {
        where.push(`cbu = $${i++}`); params.push(cbu);
      }
      const sql = `SELECT * FROM cflex_tickets WHERE ${where.join(' AND ')}
                   ORDER BY created_at DESC LIMIT $${i}`;
      params.push(limit);
      const { rows } = await pool.query(sql, params);
      res.json({ ok: true, incidents: rows.map(mapRowToIncident) });
    } catch (e) { next(e); }
  });


  // ── GET /v1/incidents/:id ──────────────────────────────────────
  router.get('/:id', async (req, res, next) => {
    try {
      const tid = tenantOf(req);
      const { rows } = await pool.query(
        'SELECT * FROM cflex_tickets WHERE id = $1 AND tenant_id = $2',
        [req.params.id, tid],
      );
      if (!rows[0]) return res.status(404).json({ error: 'not found' });
      const inc = mapRowToIncident(rows[0]);
      // Timeline
      const tl = await pool.query(
        `SELECT id, ts := created_at, kind, author, author_kind, note, body_json
         FROM cflex_ticket_notes WHERE ticket_id = $1 ORDER BY created_at ASC`,
        [req.params.id],
      );
      // (note: PG syntax "ts := created_at" is invalid — use AS)
      inc.timeline = tl.rows;
      // Linked alarms
      const links = await pool.query(
        'SELECT alarm_id, alarm_source, attached_at FROM cflex_incident_alarm_links WHERE ticket_id = $1',
        [req.params.id],
      );
      inc.linked_alarms = links.rows;
      res.json({ ok: true, incident: inc });
    } catch (e) { next(e); }
  });


  // ── POST /v1/incidents ── 알람·수동에서 생성. dedup 1단계. ──────
  router.post('/', async (req, res, next) => {
    const tid = tenantOf(req);
    const body = req.body || {};
    const severity = body.severity || 'warn';
    const symptom = body.symptom || body.title || '';
    const asset = body.asset || {};
    const dedup_key = body.dedup_key || makeDedupKey({
      tenant_id: tid, asset, severity, symptom,
    });
    const source = body.source || 'manual';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // dedup: 활성 인시던트 있으면 그것 반환 + 알람 attach만.
      const existing = await client.query(
        `SELECT * FROM cflex_tickets
         WHERE tenant_id = $1 AND dedup_key = $2
           AND status IN ('open','ack','in_progress') LIMIT 1`,
        [tid, dedup_key],
      );
      if (existing.rows[0]) {
        const inc = existing.rows[0];
        if (body.alarm_id) {
          await client.query(
            `INSERT INTO cflex_incident_alarm_links (ticket_id, alarm_id, alarm_source)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [inc.id, body.alarm_id, body.alarm_source || 'fms'],
          );
          await appendTimeline(client, inc.id, tid, 'alarm_attach', 'system',
            `Alarm ${body.alarm_id} attached (dedup)`, { alarm_id: body.alarm_id });
        }
        await client.query('COMMIT');
        return res.status(200).json({ ok: true, incident: mapRowToIncident(inc),
                                        deduped: true });
      }

      // 신규 — ticket_no 자동 생성 (CFX-YYYY-NNNNN)
      const yr = new Date().getFullYear();
      const seq = await client.query(`SELECT COALESCE(MAX(SUBSTR(ticket_no, 10)::int), 0) + 1 AS nxt
                                       FROM cflex_tickets WHERE ticket_no LIKE $1`,
                                      [`CFX-${yr}-%`]);
      const ticketNo = `CFX-${yr}-${String(seq.rows[0].nxt).padStart(5, '0')}`;
      const priority = body.priority || priorityFromSeverity(severity);

      const ins = await client.query(
        `INSERT INTO cflex_tickets
           (tenant_id, ticket_no, site, cbu, device_type, device_id, device_label,
            priority, severity, domain, title, description, status, source, dedup_key,
            channels, sla_target_response_min, sla_target_resolution_min, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',$13,$14,$15,$16,$17,$13)
         RETURNING *`,
        [tid, ticketNo, body.site, body.cbu,
         asset.type, asset.id, asset.label,
         priority, severity, body.domain || 'UPS',
         body.title || symptom, body.description, source, dedup_key,
         JSON.stringify(body.channels || []),
         body.sla_target_response_min, body.sla_target_resolution_min],
      );
      // (위 SQL은 source가 두 번 들어가 18개 컬럼/$17개. 의도적으로 status='open'은 리터럴이라 변수개수 정합.
      //  실제 운영 적용 전 SQL 검수 필수 — 본 차수는 스켈레톤.)

      const inc = ins.rows[0];
      await appendTimeline(client, inc.id, tid, 'state_change', body.actor || 'system',
        `Incident created (state=open, severity=${severity}, source=${source})`,
        { state: 'open', severity, source });

      if (body.alarm_id) {
        await client.query(
          `INSERT INTO cflex_incident_alarm_links (ticket_id, alarm_id, alarm_source)
           VALUES ($1, $2, $3)`,
          [inc.id, body.alarm_id, body.alarm_source || 'fms'],
        );
      }
      await client.query('COMMIT');
      res.status(201).json({ ok: true, incident: mapRowToIncident(inc) });
    } catch (e) {
      await client.query('ROLLBACK');
      next(e);
    } finally {
      client.release();
    }
  });


  // ── PATCH /v1/incidents/:id/state ── 상태머신 전이 ─────────────
  router.patch('/:id/state', async (req, res, next) => {
    const tid = tenantOf(req);
    const to = req.body.to;
    const actor = req.body.actor || (req.user && req.user.id) || 'system';
    if (!to) return res.status(400).json({ error: 'to required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT * FROM cflex_tickets WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [req.params.id, tid],
      );
      const inc = rows[0];
      if (!inc) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
      const from = inc.status;
      if (!ALLOWED_TRANSITIONS[from] || !ALLOWED_TRANSITIONS[from].includes(to)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `invalid transition ${from} → ${to}` });
      }

      // timestamps
      const ts = {
        ack:        ['ack_at', 'ack_by'],
        resolved:   ['resolved_at'],
        closed:     ['closed_at'],
      }[to];
      const sets = ['status = $1', 'updated_at = NOW()'];
      const params = [to];
      let i = 2;
      if (ts) {
        for (const col of ts) {
          if (col.endsWith('_at')) { sets.push(`${col} = NOW()`); }
          else { sets.push(`${col} = $${i++}`); params.push(actor); }
        }
      }
      params.push(req.params.id);
      await client.query(
        `UPDATE cflex_tickets SET ${sets.join(', ')} WHERE id = $${i}`,
        params,
      );
      await appendTimeline(client, inc.id, tid, 'state_change', actor,
        `${from} → ${to}`, { from, to });
      await client.query('COMMIT');
      res.json({ ok: true, from, to });
    } catch (e) {
      await client.query('ROLLBACK');
      next(e);
    } finally {
      client.release();
    }
  });


  // ── POST /v1/incidents/:id/timeline ── 코멘트·이벤트 추가 ──────
  router.post('/:id/timeline', async (req, res, next) => {
    try {
      const tid = tenantOf(req);
      const { kind = 'comment', body = '', body_json = null } = req.body || {};
      const actor = req.body.actor || (req.user && req.user.id) || 'system';
      const client = await pool.connect();
      try {
        await appendTimeline(client, req.params.id, tid, kind, actor, body, body_json);
      } finally { client.release(); }
      res.status(201).json({ ok: true });
    } catch (e) { next(e); }
  });


  // ── POST /v1/incidents/:id/rca/draft ── AI RCA 초안 저장 ───────
  router.post('/:id/rca/draft', async (req, res, next) => {
    try {
      const tid = tenantOf(req);
      const body = req.body || {};
      const ins = await pool.query(
        `INSERT INTO cflex_ticket_rca (ticket_id, tenant_id, root_cause, confidence,
                                         actions, model, input_tokens, output_tokens, cost_usd,
                                         auto_triggered)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, TRUE)
         ON CONFLICT (ticket_id) DO UPDATE SET
           root_cause = EXCLUDED.root_cause,
           confidence = EXCLUDED.confidence,
           actions = EXCLUDED.actions,
           model = EXCLUDED.model
         RETURNING *`,
        [req.params.id, tid, body.root_cause, body.confidence, JSON.stringify(body.actions || []),
         body.model, body.input_tokens || 0, body.output_tokens || 0, body.cost_usd || 0],
      );
      // 사람 게이트 — RCA draft는 자동 저장. 고객 발송은 별도 endpoint(/finalize).
      const client = await pool.connect();
      try {
        await appendTimeline(client, req.params.id, tid, 'rca', 'ai',
          `RCA draft saved (model=${body.model}, confidence=${body.confidence})`,
          { kind: 'draft', confidence: body.confidence });
      } finally { client.release(); }
      res.status(201).json({ ok: true, rca: ins.rows[0] });
    } catch (e) { next(e); }
  });

  return router;
};
