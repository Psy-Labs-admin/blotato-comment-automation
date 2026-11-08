'use strict';

(() => {
  const el = (id) => document.getElementById(id);
  const labels = {
    starting: 'Starting', running: 'Running', waiting_input: 'Waiting for email',
    blocked_unknown: 'Needs review', completed: 'Completed', expired: 'Expired',
    cancelled: 'Cancelled', failed: 'Failed', accepted: 'Accepted', unknown: 'Uncertain',
    format_valid_unverified: 'Format checked · ownership unverified', synced: 'Synced',
    pending: 'Pending', deferred: 'Deferred', rejected: 'Rejected', blocked: 'Blocked',
  };
  let credentials = null;
  let session = 0;
  let refreshVersion = 0;
  let detailVersion = 0;
  let selectedRun = null;
  let resolutionIntent = null;
  let lookupVersion = 0;
  let nextCursor = null;
  let runCache = [];
  let demoTenant = null;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }

  function message(id, text) {
    el(id).textContent = text || '';
    el(id).hidden = !text;
  }

  function formatTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function humanize(value) {
    return labels[value] || String(value || '—').replaceAll('_', ' ');
  }

  function badge(status) {
    const tone = status === 'completed' || status === 'accepted' ? 'success'
      : status === 'blocked_unknown' || status === 'unknown' ? 'warning'
      : status === 'failed' || status === 'rejected' || status === 'blocked' ? 'failed' : '';
    return node('span', humanize(status), 'badge ' + tone);
  }

  async function api(path, options = {}) {
    if (!credentials) throw new Error('Connect your workspace first.');
    const headers = { 'Accept': 'application/json', ...options.headers };
    if (credentials.token) headers.Authorization = 'Bearer ' + credentials.token;
    else headers['x-tenant-id'] = credentials.tenant;
    if (options.body) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(path, {
        ...options, headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new Error(error.name === 'TimeoutError'
        ? 'The request timed out. Refresh to check the latest recorded state.'
        : 'Could not reach the service. Check your connection and try again.');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Access denied. Disconnect and check your workspace credentials.');
      }
      throw new Error(body.error || 'Request failed (' + response.status + '). Refresh and try again.');
    }
    return body;
  }

  function renderFunnel(data) {
    const metrics = [
      ['Matched comments', data.matchedComments], ['Runs started', data.runsStarted],
      ['Questions accepted', data.promptsAccepted], ['Emails captured', data.emailsCaptured],
      ['Links accepted', data.linksAccepted], ['CRM synced', data.crmSynced],
    ];
    el('funnel').replaceChildren(...metrics.map(([label, value]) => {
      const item = node('div', undefined, 'funnel-item');
      item.append(node('strong', Number(value).toLocaleString()), node('span', label));
      return item;
    }));
    el('funnel').setAttribute('aria-label', 'All-time automation funnel. ' + data.sendsUnknown + ' uncertain sends.');
  }

  function renderRuns(runs) {
    el('run-count').textContent = String(runs.length);
    if (!runs.length) {
      const empty = node('div', undefined, 'empty');
      empty.append(node('h3', 'No runs found'), node('p', el('status').value
        ? 'Choose another status to see more conversations.'
        : 'Runs appear here when a comment matches a published automation.'));
      el('runs').replaceChildren(empty);
      return;
    }
    el('runs').replaceChildren(...runs.map((run) => {
      const button = node('button', undefined, 'run-button');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(run.id === selectedRun));
      button.setAttribute('aria-label', 'Open run ' + run.id + ', ' + humanize(run.status));
      button.dataset.runId = run.id;
      const top = node('div', undefined, 'run-top');
      top.append(node('span', run.automation_name || 'Automation run', 'run-name'), badge(run.status));
      button.append(top, node('span', run.participant_id, 'run-participant'), node('span', formatTime(run.created_at), 'run-date'));
      if (run.status_reason) button.append(node('span', humanize(run.status_reason), 'run-reason'));
      button.addEventListener('click', () => openRun(run.id));
      return button;
    }));
  }

  async function refresh(older = false) {
    const currentSession = session;
    const version = ++refreshVersion;
    el('refresh').disabled = true;
    el('load-older').disabled = true;
    message('error', '');
    try {
      const query = new URLSearchParams();
      const status = el('status').value;
      if (status === 'needs_review') query.set('needsReview', 'true');
      else if (status) query.set('status', status);
      if (older && nextCursor) query.set('cursor', nextCursor);
      const [funnel, result] = await Promise.all([api('/funnel'), api('/runs?' + query)]);
      if (session !== currentSession || version !== refreshVersion) return;
      renderFunnel(funnel);
      const combined = older ? [...runCache, ...result.runs] : result.runs;
      runCache = [...new Map(combined.map((run) => [run.id, run])).values()];
      nextCursor = result.nextCursor || null;
      renderRuns(runCache);
      el('load-older').hidden = !nextCursor;
      el('updated').textContent = 'Updated ' + formatTime(new Date());
      if (selectedRun) await openRun(selectedRun, false);
    } catch (error) {
      if (session === currentSession && version === refreshVersion) message('error', error.message);
    } finally {
      if (session === currentSession && version === refreshVersion) {
        el('refresh').disabled = false;
        el('load-older').disabled = false;
      }
    }
  }

  function renderFacts(detail) {
    const facts = node('dl', undefined, 'facts');
    const values = [['Started', formatTime(detail.run.created_at)], ['Current step', humanize(detail.run.current_step)]];
    if (detail.run.finished_at) values.push(['Finished', formatTime(detail.run.finished_at)]);
    if (detail.run.status_reason) values.push(['Reason', humanize(detail.run.status_reason)]);
    if (detail.lead) values.push(['Email', detail.lead.email], ['Email check', humanize(detail.lead.email_status)], ['CRM', humanize(detail.lead.crm_status)]);
    for (const wait of detail.waits) {
      if (wait.deadline && !detail.run.finished_at) values.push(['Reply deadline', formatTime(wait.deadline)]);
    }
    for (const [label, value] of values) {
      const item = node('div');
      item.append(node('dt', label), node('dd', value));
      facts.append(item);
    }
    return facts;
  }

  function renderDetail(detail, entries) {
    const { run, intents } = detail;
    const heading = node('div', undefined, 'detail-heading');
    const title = node('h2', run.automation_name || 'Conversation');
    title.id = 'detail-title';
    const titleGroup = node('div');
    titleGroup.append(title, node('p', 'Participant ' + run.participant_id + ' · Run ' + run.id, 'run-id'));
    heading.append(titleGroup, badge(run.status));
    const content = [heading, renderFacts(detail)];
    if (detail.postMetadata) {
      const post = detail.postMetadata;
      const metadata = post.metadata || {};
      const panel = node('details', undefined, 'post-metadata');
      panel.append(node('summary', 'Trigger post'));
      if (metadata.caption) panel.append(node('p', metadata.caption));
      if (metadata.mediaType) panel.append(node('p', humanize(metadata.mediaType)));
      if (metadata.permalink) {
        try {
          const url = new URL(metadata.permalink);
          if (url.protocol === 'https:') {
            const link = node('a', 'Open post');
            link.href = url.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            panel.append(link);
          }
        } catch (_) { /* Invalid provider links are omitted. */ }
      }
      panel.append(node('p', 'Metadata ' + humanize(post.status || 'pending') +
        (post.fetched_at ? ' · Updated ' + formatTime(post.fetched_at) : ''), 'help'));
      content.push(panel);
    }
    const unknown = intents.filter((intent) => intent.status === 'unknown');
    for (const intent of unknown) {
      const alert = node('div', undefined, 'alert-box');
      alert.append(node('h3', 'Message needs review'), node('p',
        humanize(intent.step_id) + ' has an uncertain outcome. The conversation stays held until evidence confirms what happened.'));
      const resolve = node('button', 'Review outcome');
      resolve.type = 'button';
      resolve.addEventListener('click', () => {
        resolutionIntent = intent.id;
        el('resolve-form').reset();
        message('resolve-error', '');
        el('resolve-dialog').showModal();
      });
      alert.append(resolve);
      content.push(alert);
    }
    const timelineHeading = node('h3', 'Conversation timeline');
    const timeline = node('ol', undefined, 'timeline');
    for (const entry of entries) {
      const tone = entry.type === 'send.unknown' || entry.type === 'send.blocked' ? 'attention'
        : entry.type === 'send.accepted' || entry.type === 'input.accepted' ? 'accepted' : '';
      const item = node('li', undefined, tone);
      const time = node('time', formatTime(entry.at));
      time.dateTime = entry.at;
      time.title = entry.at;
      item.append(node('p', entry.text), time);
      timeline.append(item);
    }
    if (!entries.length) timeline.append(node('li', 'No timeline entries have been recorded yet.'));
    content.push(timelineHeading, timeline);
    const summary = node('details', undefined, 'message-summary');
    summary.append(node('summary', 'Message outcomes (' + intents.length + ')'));
    for (const intent of intents) {
      const row = node('div', undefined, 'message-row');
      row.append(node('span', humanize(intent.step_id) + ' · ' + humanize(intent.kind)), badge(intent.status));
      summary.append(row);
    }
    content.push(summary);
    if (!run.finished_at) {
      const cancel = node('button', 'Cancel run', 'danger');
      cancel.type = 'button';
      cancel.addEventListener('click', () => cancelRun(run.id, cancel));
      const actions = node('div', undefined, 'dialog-actions');
      actions.append(cancel);
      content.push(actions);
    }
    el('detail').replaceChildren(...content);
  }

  async function openRun(id, announce = true) {
    selectedRun = id;
    const version = ++detailVersion;
    const currentSession = session;
    for (const button of el('runs').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.runId === id));
    }
    el('detail').setAttribute('aria-busy', 'true');
    if (announce) {
      message('notice', 'Loading conversation…');
      const title = node('h2', 'Loading conversation…');
      title.id = 'detail-title';
      el('detail').replaceChildren(title);
    }
    try {
      const [detail, timeline] = await Promise.all([
        api('/runs/' + encodeURIComponent(id)), api('/runs/' + encodeURIComponent(id) + '/timeline'),
      ]);
      if (session !== currentSession || version !== detailVersion) return;
      renderDetail(detail, timeline.entries);
      if (announce) message('notice', '');
    } catch (error) {
      if (session === currentSession && version === detailVersion) {
        message('notice', '');
        message('error', error.message);
        const title = node('h2', 'Conversation unavailable');
        title.id = 'detail-title';
        el('detail').replaceChildren(title, node('p', 'Could not load this conversation. Select the run again to retry.', 'error'));
      }
    } finally {
      if (session === currentSession && version === detailVersion) el('detail').removeAttribute('aria-busy');
    }
  }

  async function cancelRun(id, button) {
    if (!window.confirm('Request cancellation of this run? A message already being sent may still be accepted.')) return;
    const currentSession = session;
    button.disabled = true;
    try {
      await api('/runs/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: JSON.stringify({ reason: 'operator_console' }) });
      if (session !== currentSession) return;
      await refresh();
      message('notice', 'Cancellation requested. Refresh to follow the final outcome.');
    } catch (error) {
      if (session === currentSession) message('error', error.message);
    } finally {
      button.disabled = false;
    }
  }

  el('open-demo').addEventListener('click', () => {
    if (!demoTenant) return;
    el('token').value = '';
    el('tenant').value = demoTenant;
    el('connect-form').requestSubmit();
  });
  fetch('/demo/workspace', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000) })
    .then((response) => response.ok ? response.json() : null)
    .then((data) => {
      if (data && typeof data.tenantId === 'string') {
        demoTenant = data.tenantId;
        el('open-demo').hidden = false;
      }
    })
    .catch(() => {});

  el('connect-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = el('token').value.trim();
    const tenant = el('tenant').value.trim();
    if (!token && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) {
      message('login-error', 'Enter an access token, or a valid workspace UUID for local development.');
      return;
    }
    credentials = { token, tenant: token ? '' : tenant };
    const currentSession = ++session;
    el('connect-button').disabled = true;
    message('login-error', '');
    try {
      await api('/funnel');
      if (session !== currentSession) return;
      el('login').hidden = true;
      el('workspace').hidden = false;
      el('session').hidden = false;
      el('workspace-label').textContent = token ? 'Secured workspace' : 'Local workspace ' + tenant.slice(0, 8);
      el('connect-form').reset();
      const target = new URLSearchParams(location.hash.slice(1)).get('run');
      if (target && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(target)) selectedRun = target;
      await refresh();
    } catch (error) {
      if (session === currentSession) {
        credentials = null;
        message('login-error', error.message);
      }
    } finally {
      el('connect-button').disabled = false;
    }
  });

  el('disconnect').addEventListener('click', () => {
    session++;
    refreshVersion++;
    detailVersion++;
    credentials = null;
    runCache = [];
    nextCursor = null;
    selectedRun = null;
    resolutionIntent = null;
    lookupVersion++;
    el('resolve-dialog').close();
    el('workspace').hidden = true;
    el('session').hidden = true;
    el('login').hidden = false;
    for (const id of ['funnel', 'runs', 'detail', 'event-result']) el(id).replaceChildren();
    const empty = node('div', undefined, 'empty');
    const title = node('h2', 'Choose a conversation');
    title.id = 'detail-title';
    empty.append(title, node('p', 'Select a run to inspect its timeline and message outcomes.'));
    el('detail').replaceChildren(empty);
    el('event-form').reset();
    message('error', '');
    message('notice', '');
    el('token').focus();
  });
  el('refresh').addEventListener('click', () => refresh());
  el('load-older').addEventListener('click', () => refresh(true));
  el('status').addEventListener('change', () => refresh());
  el('close-resolve').addEventListener('click', () => el('resolve-dialog').close());

  el('resolve-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const currentSession = session;
    const values = new FormData(el('resolve-form'));
    const note = el('resolution-note').value.trim();
    if (!note) {
      message('resolve-error', 'Describe the evidence for your decision.');
      return;
    }
    el('save-resolution').disabled = true;
    message('resolve-error', '');
    try {
      await api('/intents/' + encodeURIComponent(resolutionIntent) + '/resolve', {
        method: 'POST', body: JSON.stringify({ resolution: values.get('resolution'), note }),
      });
      if (session !== currentSession) return;
      el('resolve-dialog').close();
      await refresh();
      message('notice', 'Decision recorded. The conversation will continue according to its saved state.');
    } catch (error) {
      if (session === currentSession) message('resolve-error', error.message);
    } finally {
      el('save-resolution').disabled = false;
    }
  });

  el('event-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = el('event-id').value.trim();
    const version = ++lookupVersion;
    const currentSession = session;
    el('event-result').replaceChildren(node('p', 'Looking up event…'));
    try {
      const result = await api('/events/' + encodeURIComponent(id));
      if (session !== currentSession || version !== lookupVersion) return;
      const text = node('p', humanize(result.eventType) + ' · ' + humanize(result.routingOutcome || result.routingStatus));
      el('event-result').replaceChildren(text);
      if (result.runId) {
        const open = node('button', 'Open associated run');
        open.type = 'button';
        open.addEventListener('click', () => openRun(result.runId));
        el('event-result').append(open);
      }
    } catch (error) {
      if (session === currentSession && version === lookupVersion) el('event-result').replaceChildren(node('p', error.message, 'error'));
    }
  });
})();
