/**
 * Incident texts for Telegram / chat ops. They say what broke, how many conversations are
 * affected, since when, what was already done automatically and what a person must do.
 * Never message bodies, emails or participant identifiers.
 */
const PLAYBOOK: Record<string, { title: string; auto: string; action: string }> = {
  send_outcome_unknown: {
    title: 'Instagram sends with unknown outcome',
    auto: 'Conversations are held, nothing is re-sent automatically; reconciliation attempted where the adapter supports it.',
    action: 'Review GET /runs?needsReview=true and resolve each intent via POST /intents/:id/resolve.',
  },
  connection_unauthorized: {
    title: 'Instagram account access revoked or expired',
    auto: 'All automated sends for this account are paused.',
    action: 'Ask the customer to reconnect the Instagram account.',
  },
  crm_delivery_failing: {
    title: 'CRM sync failing',
    auto: 'Conversations continue; lead delivery is retried independently with backoff.',
    action: 'Check the CRM integration if the backlog keeps growing.',
  },
  outbox_dead_letter: {
    title: 'Background delivery gave up',
    auto: 'The item is kept as dead-letter for inspection; nothing was lost.',
    action: 'Inspect dead outbox rows and redeliver after fixing the cause.',
  },
};

export function formatIncident(
  inc: { error_class: string; occurrences: number; affected_runs: string[]; first_seen_at: Date; tenant_name: string; account: string | null },
  kind: 'opened' | 'update' | 'resolved',
  consoleUrl?: string,
): string {
  const p = PLAYBOOK[inc.error_class] ?? { title: inc.error_class, auto: '-', action: '-' };
  const head = kind === 'resolved' ? 'RESOLVED' : kind === 'opened' ? 'INCIDENT' : 'STILL OPEN';
  const scope = `${inc.tenant_name}${inc.account ? ` · account ${inc.account}` : ''}`;
  if (kind === 'resolved') return `[${head}] ${p.title}\n${scope}\nRecovered; no action needed.`;
  return [
    `[${head}] ${p.title}`,
    scope,
    `Affected conversations: ${inc.affected_runs.length} · occurrences: ${inc.occurrences} · since ${new Date(inc.first_seen_at).toISOString()}`,
    `Done automatically: ${p.auto}`,
    `Action: ${p.action}`,
    ...(consoleUrl ? [consoleUrl + (inc.affected_runs[0] ? '#run=' + encodeURIComponent(inc.affected_runs[0]) : '')] : []),
  ].join('\n');
}
