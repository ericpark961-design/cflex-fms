// The two shapes net-snmp's agent needs, so three simulators do not each
// rediscover them.
//
// Both were got wrong first time, and both failed the same way — the agent
// started, listened, and answered "No Such Object" to everything:
//
//   · a Scalar provider is not readable until mib.setScalarValue() has been
//     called for it, and the handler has to set the value and then call
//     req.done() with no arguments. Passing the value through req.done()
//     registers nothing.
//   · a table has to be a Table provider with tableColumns and tableIndex,
//     and its rows added with mib.addTableRow(). Registering one Scalar per
//     fully-indexed OID looks right and serves nothing, because a scalar's
//     instance is <oid>.0.
const snmp = require('net-snmp');

/** An agent with one read-only community, ready for providers. */
function agent({ port, community = 'public' }) {
  const a = snmp.createAgent({
    port,
    disableAuthorization: false,
    accessControlModelType: snmp.AccessControlModelType.Simple,
  });
  const auth = a.getAuthorizer();
  auth.addCommunity(community);
  auth.getAccessControlModel().setCommunityAccess(community, snmp.AccessLevel.ReadOnly);
  return { agent: a, mib: a.getMib() };
}

/**
 * A scalar whose value is recomputed on every read.
 * @param get () => number|string
 */
function scalar(mib, { oid, name, type, get }) {
  mib.registerProvider({
    name, type: snmp.MibProviderType.Scalar, oid, scalarType: type,
    maxAccess: snmp.MaxAccess['read-only'],
    handler: (req) => { mib.setScalarValue(name, get()); req.done(); },
  });
  mib.setScalarValue(name, get());            // without this the OID is not readable
}

/**
 * A table.
 *
 * @param columns [{number, name, type}] — `number` is the column sub-identifier
 * @param rows    () => [[...values]]      one array per row, index column first
 */
function table(mib, { oid, name, columns, rows, index = [1] }) {
  mib.registerProvider({
    name, type: snmp.MibProviderType.Table, oid,
    tableColumns: columns.map(c => ({
      number: c.number, name: c.name, type: c.type,
      maxAccess: snmp.MaxAccess['read-only'],
    })),
    tableIndex: index,
    // The handler refreshes every row before the read, so a walk during drift
    // sees one consistent snapshot rather than a mix of two.
    handler: (req) => { refresh(mib, name, rows()); req.done(); },
  });
  refresh(mib, name, rows());
}

function refresh(mib, name, data) {
  // There is no bulk replace, so rows are re-added; addTableRow overwrites a
  // row with the same index.
  for (const row of data) mib.addTableRow(name, row);
}

const T = snmp.ObjectType;

/** The SNMPv2-MIB scalars every agent should answer. */
function sysGroup(mib, { descr, name: sysName, location = 'Sim Site', contact = 'noc@runless.io' }) {
  const started = Date.now();
  scalar(mib, { oid: '1.3.6.1.2.1.1.1', name: 'sysDescr', type: T.OctetString, get: () => descr });
  scalar(mib, { oid: '1.3.6.1.2.1.1.3', name: 'sysUpTime', type: T.TimeTicks, get: () => Math.round((Date.now() - started) / 10) });
  scalar(mib, { oid: '1.3.6.1.2.1.1.4', name: 'sysContact', type: T.OctetString, get: () => contact });
  scalar(mib, { oid: '1.3.6.1.2.1.1.5', name: 'sysName', type: T.OctetString, get: () => sysName });
  scalar(mib, { oid: '1.3.6.1.2.1.1.6', name: 'sysLocation', type: T.OctetString, get: () => location });
}

module.exports = { agent, scalar, table, sysGroup, T, snmp };
