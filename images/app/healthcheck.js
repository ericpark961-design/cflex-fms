// cflex/app HEALTHCHECK — 200 from /healthz (503 there means Redis is unreachable, so this node
// cannot authenticate anyone and nginx should send users to the peer).
'use strict';
const port = parseInt(process.env.CONSOLE_PORT || '8080', 10);
const req = require('http').get({ host: '127.0.0.1', port, path: '/healthz', timeout: 4000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
