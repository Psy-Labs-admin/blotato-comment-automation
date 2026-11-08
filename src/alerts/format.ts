/**
 * Incident texts for Telegram / chat ops. They say what broke, how many automation runs are
 * affected, since when, what was already done automatically and what a person must do.
 * Never message bodies, emails or participant identifiers.
 */
const PLAYBOOK: Record<string, { title: string; auto: string; action: string }> = {
  send_outcome_unknown: {
    title: 'Instagram sends with unknown outcome',
    auto: 'Conversations are held, nothing is re-sent automatically; reconciliation attempted where the adapter supports it.',
    action: 'Open the incident in Operations, review each affected conversation in Instagram, then record the confirmed message outcome in Conversations.',
  },
  connection_unauthorized: {
    title: 'Instagram account access revoked or expired',
    auto: 'All automated sends for this account are paused.',
    action: 'Open Accounts and reconnect the affected Instagram account.',
  },
  crm_delivery_failing: {
    title: 'CRM sync failing',
    auto: 'Conversations continue; lead delivery is retried independently with backoff.',
    action: 'Check the CRM connection, then open Operations → Background deliveries and retry eligible failed deliveries.',
  },
  outbox_dead_letter: {
    title: 'Background delivery gave up',
    auto: 'The stopped delivery is retained for review.',
    action: 'Open Operations → Background deliveries, fix the reported cause, then retry eligible failed deliveries.',
  },
};

export function formatIncident(
  inc: { id?: string; tenant_id?: string; connection_id?: string | null; error_class: string; occurrences: number; affected_runs: string[]; first_seen_at: Date; tenant_name?: string; account?: string | null },
  kind: 'opened' | 'update' | 'resolved',
  consoleUrl?: string,
): string {
  const p = PLAYBOOK[inc.error_class] ?? { title: 'Operational incident', auto: 'The incident is recorded for inspection.', action: 'Review the incident in the console.' };
  const head = kind === 'resolved' ? 'RESOLVED' : kind === 'opened' ? 'INCIDENT' : 'STILL OPEN';
  const scope = 'Workspace ' + (inc.tenant_id?.slice(0, 8) ?? 'unknown') + (inc.connection_id ? ' · connection ' + inc.connection_id.slice(0, 8) : '');
  const link = incidentLink(consoleUrl, inc.id);
  if (kind === 'resolved') return [`[${head}] ${p.title}`, scope, 'The recorded condition has cleared.', ...(link ? [link] : [])].join('\n');
  return [
    `[${head}] ${p.title}`,
    scope,
    `Affected automation runs: ${inc.affected_runs.length} · occurrences: ${inc.occurrences} · since ${new Date(inc.first_seen_at).toISOString()}`,
    `Done automatically: ${p.auto}`,
    `Action: ${p.action}`,
    ...(link ? [link] : []),
  ].join('\n');
}

function incidentLink(base: string | undefined, incidentId: string | undefined): string | undefined {
  if (!base) return undefined;
  try {
    const url = new URL(base);
    const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/console') return undefined;
    url.hash = incidentId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(incidentId) ? 'incident=' + incidentId : 'operations';
    return url.toString();
  } catch { return undefined; }
}
