// A dummy SMTP relay for tests: EHLO, AUTH PLAIN/LOGIN, MAIL/RCPT/DATA, QUIT.
// Records every accepted message. `state.rejectRcpt` answers RCPT with 550,
// `state.requireAuth` refuses MAIL before AUTH. 127.0.0.1 only.
const net = require('node:net');

function startDummySmtp({ user = null, pass = null, mechs = 'PLAIN LOGIN' } = {}) {
  const state = { messages: [], sessions: 0, rejectRcpt: false, requireAuth: !!user, commands: [] };
  const srv = net.createServer((sock) => {
    state.sessions++;
    let buf = '';
    let inData = false;
    let data = [];
    let msg = { from: null, to: [], authed: !user };
    let login = null;
    const say = (s) => sock.write(s + '\r\n');
    say('220 dummy.smtp ESMTP ready');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            state.messages.push({ from: msg.from, to: msg.to, raw: data.join('\r\n') });
            data = [];
            msg = { from: null, to: [], authed: msg.authed };
            say('250 2.0.0 queued');
          } else data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        if (login) {
          const v = Buffer.from(line, 'base64').toString('utf8');
          if (login.step === 'user') { login.user = v; login.step = 'pass'; say('334 UGFzc3dvcmQ6'); continue; }
          const ok = login.user === user && v === pass;
          login = null; msg.authed = ok;
          say(ok ? '235 2.7.0 ok' : '535 5.7.8 bad credentials');
          continue;
        }
        state.commands.push(line.split(' ')[0].toUpperCase());
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) { sock.write(`250-dummy.smtp\r\n250-AUTH ${mechs}\r\n250 8BITMIME\r\n`); }
        else if (up.startsWith('AUTH PLAIN ')) {
          const [, u, p] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\0');
          msg.authed = u === user && p === pass;
          say(msg.authed ? '235 2.7.0 ok' : '535 5.7.8 bad credentials');
        } else if (up === 'AUTH LOGIN') { login = { step: 'user' }; say('334 VXNlcm5hbWU6'); }
        else if (up.startsWith('MAIL FROM:')) {
          if (state.requireAuth && !msg.authed) { say('530 5.7.0 authentication required'); continue; }
          msg.from = /<([^>]*)>/.exec(line)?.[1]; say('250 ok');
        } else if (up.startsWith('RCPT TO:')) {
          if (state.rejectRcpt) { say('550 5.1.1 mailbox unavailable'); continue; }
          msg.to.push(/<([^>]*)>/.exec(line)?.[1]); say('250 ok');
        } else if (up === 'DATA') { inData = true; say('354 go ahead'); }
        else if (up === 'QUIT') { say('221 bye'); sock.end(); }
        else if (up === 'RSET' || up === 'NOOP') say('250 ok');
        else say('502 5.5.2 not implemented');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    host: '127.0.0.1', port: srv.address().port, state,
    close: () => new Promise(r => srv.close(r)),
  })));
}

/** The decoded text/plain (and html) parts of a recorded message. */
function decode(raw) {
  const subject = /^Subject: (.*)$/m.exec(raw)?.[1] || '';
  const subj = subject.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
  const parts = raw.split(/\r\n--cflex-[0-9a-f]+(?:--)?\r\n/);
  const bodies = [];
  for (const p of parts) {
    const m = /Content-Type: (text\/\w+)[^\r]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*)$/.exec(p);
    if (m) bodies.push({ type: m[1], text: Buffer.from(m[2].replace(/\s+/g, ''), 'base64').toString('utf8') });
  }
  return { subject: subj, text: bodies.find(b => b.type === 'text/plain')?.text || '', html: bodies.find(b => b.type === 'text/html')?.text || '' };
}

module.exports = { startDummySmtp, decode };
