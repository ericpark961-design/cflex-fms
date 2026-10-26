// A throwaway PostgreSQL 16 for the tests (devDependency embedded-postgres):
// initdb in a temp directory, 127.0.0.1 on a free port, gone when stop() runs.
// Not a production dependency — db01 runs rhel8/postgresql-16.
//
//   const pgt = require('./support/pg');
//   test('…', { skip: pgt.unavailable }, …)      a reason string when it cannot run
//   const pg = await pgt.start();                 { url(db), createDatabase(name), admin(), stop() }
//
// The app connects as the role `cflex` (not a superuser, as on db01) with the
// fixture password below — a test value, not a secret.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const PASSWORD = 'not-a-secret';
const ROOT = path.resolve(__dirname, '../..');

function reason() {
  let main;
  try { main = require.resolve('embedded-postgres', { paths: [ROOT] }); } catch {
    return 'embedded-postgres not installed — npm install --include=dev in apps/console';
  }
  // The binaries come as an optional platform package next to it (its `exports` hide package.json from require.resolve).
  const plat = `@embedded-postgres/${process.platform}-${process.arch}`;
  const near = [path.join(ROOT, 'node_modules', plat), path.join(path.dirname(main), '..', 'node_modules', plat)];
  if (!near.some(d => fs.existsSync(path.join(d, 'native', 'bin', 'postgres')))) return `${plat} (PostgreSQL 16 binaries) not installed`;
  return false;
}
const unavailable = reason();

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function start({ database = 'cflex' } = {}) {
  if (unavailable) throw new Error(unavailable);
  const { default: EmbeddedPostgres } = await import(require.resolve('embedded-postgres', { paths: [ROOT] }));
  const { Client } = require(require.resolve('pg', { paths: [ROOT] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-pg-'));
  const port = await freePort();
  const log = [];
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(dir, 'data'), port, user: 'postgres', password: PASSWORD, authMethod: 'scram-sha-256',
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=en_US.UTF-8'],
    onLog: (m) => log.push(String(m)), onError: (m) => log.push(String(m)),
  });
  try {
    await pg.initialise();
  } catch {
    // Some hosts have no en_US.UTF-8 locale; the schema does not depend on it (COLLATE "C" where order matters).
    fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true });
    pg.options.initdbFlags = ['--encoding=UTF8'];
    await pg.initialise();
  }
  await pg.start();
  const adminUrl = (db = 'postgres') => `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/${db}`;
  const admin = async (sql, db = 'postgres') => {
    const c = new Client({ connectionString: adminUrl(db) });
    await c.connect();
    try { return (await c.query(sql)).rows; } finally { await c.end(); }
  };
  await admin(`CREATE ROLE cflex LOGIN PASSWORD '${PASSWORD}'`);
  const createDatabase = async (name) => { await admin(`CREATE DATABASE ${name} OWNER cflex`); return url(name); };
  const url = (db = database) => `postgres://cflex@127.0.0.1:${port}/${db}`;
  await createDatabase(database);
  return {
    port, dir, log, password: PASSWORD, url, adminUrl, admin, createDatabase,
    /** connection options as config.db has them, with the password in a file the way production reads it */
    conn(db = database) {
      const f = path.join(dir, 'pg.pass');
      if (!fs.existsSync(f)) fs.writeFileSync(f, PASSWORD, { mode: 0o600 });
      return { url: url(db), passwordFile: f };
    },
    async stop() {
      await pg.stop().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { start, unavailable, PASSWORD };
