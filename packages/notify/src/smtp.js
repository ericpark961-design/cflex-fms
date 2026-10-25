// A minimal SMTP submission client, for a customer relay.
//
// HAEA requires its own relay (25 or 587) and the collector has no package
// repository beyond Satellite AppStream, so a mail library is one more thing
// to carry in the offline bundle. What a relay needs is small: EHLO, STARTTLS
// when offered (or required), AUTH PLAIN/LOGIN when credentials are given,
// MAIL/RCPT/DATA, QUIT. That is all this does.
//
// `smtpSender(opts)` returns the `({to, from, subject, text, html}) =>
// {messageId}` function the email channel takes as `deps.smtpSend`.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const os = require('node:os');

/** Reads SMTP replies (multi-line `250-…` / final `250 …`) off a socket. */
function replyReader(getSocket) {
  let buf = '';
  let lines = [];
  let waiter = null;
  let failed = null;
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: lines.map(l => l.slice(4)) };
        lines = [];
        if (waiter) { const w = waiter; waiter = null; w.resolve(reply); }
      }
    }
  };
  const onError = (e) => { failed = e; if (waiter) { const w = waiter; waiter = null; w.reject(e); } };
  return {
    attach(sock) { sock.on('data', onData); sock.on('error', onError); sock.on('close', () => onError(new Error('connection closed'))); },
    detach(sock) { sock.removeListener('data', onData); sock.removeAllListeners('error'); sock.removeAllListeners('close'); sock.on('error', () => {}); },
    next() {
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    get socket() { return getSocket(); },
  };
}

/** Dot-stuffing and CRLF normalisation for DATA (RFC 5321 §4.5.2). */
function dataBody(raw) {
  return raw.replace(/\r?\n/g, '\r\n').split('\r\n').map(l => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
/** RFC 2047 encoded-word, only when the header is not plain ASCII. */
const hdr = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addrOf = (s) => { const m = /<([^>]+)>/.exec(s); return (m ? m[1] : s).trim(); };
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');

/** A multipart/alternative message; base64 bodies so no line-length or 8-bit surprises. */
function buildMessage({ to, from, subject, text, html, messageId, date }) {
  const boundary = 'cflex-' + crypto.randomBytes(8).toString('hex');
  const head = [
    `From: ${from}`,
    `To: ${[].concat(to).join(', ')}`,
    `Subject: ${hdr(subject || '')}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];
  if (!html) {
    return [...head, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(text || ''))].join('\r\n');
  }
  return [
    ...head, `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(text || '')),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(html)),
    `--${boundary}--`, '',
  ].join('\r\n');
}

/**
 * @param {object} o
 * @param {string} o.host
 * @param {number} [o.port]          default 587
 * @param {boolean} [o.secure]       implicit TLS (465). default false
 * @param {'auto'|'required'|'never'} [o.starttls]  default 'auto' — use it when offered
 * @param {{user:string, pass:string}} [o.auth]
 * @param {string} [o.ca]            PEM, for a relay signed by a corporate CA
 * @param {boolean} [o.rejectUnauthorized]  default true
 * @param {string} [o.heloName]      default os.hostname()
 * @param {number} [o.timeoutMs]     default 15000, for the whole transaction
 */
function smtpSender(o) {
  if (!o || !o.host) throw new Error('smtpSender: host is required');
  const port = o.port || (o.secure ? 465 : 587);
  const starttls = o.starttls || 'auto';
  const timeoutMs = o.timeoutMs || 15_000;
  const heloName = o.heloName || os.hostname() || 'localhost';
  const tlsOpts = { servername: o.servername || o.host, ca: o.ca || undefined, rejectUnauthorized: o.rejectUnauthorized !== false, minVersion: 'TLSv1.2' };

  return async function send({ to, from, subject, text, html }) {
    const recipients = [].concat(to).flatMap(s => String(s).split(',')).map(s => addrOf(s)).filter(Boolean);
    if (!recipients.length) throw new Error('smtp: no recipient');
    if (!from) throw new Error('smtp: no sender');
    const domain = addrOf(from).split('@')[1] || 'localhost';
    const messageId = `<${crypto.randomUUID()}@${domain}>`;

    let sock = o.secure ? tls.connect({ host: o.host, port, ...tlsOpts }) : net.connect({ host: o.host, port });
    const rd = replyReader(() => sock);
    rd.attach(sock);
    const timer = setTimeout(() => sock.destroy(new Error(`smtp: timeout after ${timeoutMs}ms`)), timeoutMs);

    const expect = async (codes, what) => {
      const r = await rd.next();
      if (!codes.includes(r.code)) {
        const e = new Error(`smtp ${what}: ${r.code} ${r.lines.join(' ').slice(0, 200)}`);
        e.code = r.code;
        throw e;
      }
      return r;
    };
    const cmd = (line, codes, what) => { sock.write(line + '\r\n'); return expect(codes, what || line.split(' ')[0]); };

    try {
      await new Promise((res, rej) => {
        sock.once(o.secure ? 'secureConnect' : 'connect', res);
        sock.once('error', rej);
      });
      await expect([220], 'greeting');
      let ehlo = await cmd(`EHLO ${heloName}`, [250], 'EHLO');
      const has = (ext) => ehlo.lines.some(l => l.toUpperCase().startsWith(ext));

      if (!o.secure && starttls !== 'never' && (has('STARTTLS') || starttls === 'required')) {
        await cmd('STARTTLS', [220], 'STARTTLS');
        rd.detach(sock);
        sock = await new Promise((res, rej) => {
          const s = tls.connect({ socket: sock, ...tlsOpts }, () => res(s));
          s.once('error', rej);
        });
        rd.attach(sock);
        ehlo = await cmd(`EHLO ${heloName}`, [250], 'EHLO');
      }

      if (o.auth && o.auth.user) {
        const mechs = (ehlo.lines.find(l => /^AUTH[ =]/i.test(l)) || '').toUpperCase();
        if (/\bPLAIN\b/.test(mechs) || !/\bLOGIN\b/.test(mechs)) {
          await cmd(`AUTH PLAIN ${b64(`\0${o.auth.user}\0${o.auth.pass || ''}`)}`, [235], 'AUTH');
        } else {
          await cmd('AUTH LOGIN', [334], 'AUTH');
          await cmd(b64(o.auth.user), [334], 'AUTH');
          await cmd(b64(o.auth.pass || ''), [235], 'AUTH');
        }
      }

      await cmd(`MAIL FROM:<${addrOf(from)}>`, [250], 'MAIL FROM');
      for (const r of recipients) await cmd(`RCPT TO:<${r}>`, [250, 251], 'RCPT TO');
      await cmd('DATA', [354], 'DATA');
      const raw = buildMessage({ to: recipients, from, subject, text, html, messageId, date: new Date() });
      sock.write(dataBody(raw) + '\r\n.\r\n');
      const done = await expect([250], 'end of DATA');
      sock.write('QUIT\r\n');
      return { messageId, response: done.lines.join(' ').slice(0, 200) };
    } finally {
      clearTimeout(timer);
      rd.detach(sock);
      sock.end();
    }
  };
}

module.exports = { smtpSender, buildMessage, dataBody };
