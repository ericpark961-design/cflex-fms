// How a notification becomes text, and when a route is severe enough to get it.
//
// Lifted from alarm-notifier's formatMessage/shouldSend, with the FMS alert row
// replaced by a plain Notification so this module does not depend on a schema.

const SEV_RANK = { P1: 1, P2: 2, P3: 3, P4: 4 };

/** Is `priority` at least as severe as the route's floor? */
function severityAtLeast(priority, minPriority = 'P2') {
  const p = SEV_RANK[priority];
  const floor = SEV_RANK[minPriority] ?? SEV_RANK.P2;
  // An unknown priority is treated as the least severe rather than silently
  // passing every filter.
  return p != null && p <= floor;
}

/**
 * The four parts every channel builds its own layout from.
 *
 * Kept as parts, not a finished string: SMS wants one line under 320
 * characters, Teams wants an Adaptive Card, email wants HTML. A single
 * pre-rendered string forced each dispatcher to unpick it.
 */
function formatMessage(n = {}, config = {}) {
  const head = `[${n.priority || 'P4'}] ${n.deviceLabel || n.deviceId || n.title || ''}`.trim();
  const where = n.where || '';
  const body = n.title || '';
  const detail = n.detail != null ? n.detail : [
    n.metric ? `· metric: ${n.metric}` : '',
    n.value != null ? `· value: ${n.value}` : '',
    n.threshold != null ? `· threshold: ${n.threshold}` : '',
  ].filter(Boolean).join(' ');
  return {
    head, where, body, detail,
    priority: n.priority || 'P4',
    // The deep link is config, not a constant. The original hard-coded the
    // hosted dashboard, which is the wrong host for every on-premises install.
    url: n.url || config.dashboardUrl || null,
    productName: config.productName || 'C-Flex FMS',
    at: n.at ? new Date(n.at) : new Date(),
    /** One line, for SMS and any other length-limited channel. */
    oneLine(limit = 320) {
      return [head, where, body, detail].filter(Boolean).join(' ').slice(0, limit);
    },
    /** Plain text block, for email and webhooks. */
    plain() {
      return [head, where, body, detail].filter(Boolean).join('\n\n');
    },
  };
}

module.exports = { formatMessage, severityAtLeast, SEV_RANK };
