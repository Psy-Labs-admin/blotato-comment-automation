"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const content = byId("content");
  const editor = byId("editor");
  const form = byId("automation-form");
  let workspace = null;
  let overview = null;
  let accounts = [];
  let activeHash = "";
  let requestVersion = 0;
  let currentDraft = null;
  let savedForm = "";
  let editorDirty = false;
  let editorBusy = false;
  let conversationFilter = "all";
  let conversationCursor = null;
  let conversationRows = [];
  let resolutionIntentId = null;
  let operationsTab = "open";
  let incidentRows = [];
  let incidentCursor = null;
  let deliveryRows = [];
  let deliveryCursor = null;
  let deliveryStatus = "dead";
  let deliveryKind = "";
  let retryDelivery = null;
  let operationsFingerprint = null;
  let operationsChecking = false;
  let instagramFeedback = consumeInstagramFeedback();

  const dateFormat = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const numberFormat = new Intl.NumberFormat();
  const runLabels = {
    starting: "In progress",
    running: "In progress",
    waiting_input: "Waiting for reply",
    blocked_unknown: "Needs review",
    completed: "Completed",
    expired: "No reply",
    cancelled: "Stopped",
    failed: "Needs attention",
  };

  function consumeInstagramFeedback() {
    const url = new URL(location.href);
    const result = url.searchParams.get("instagram");
    if (result === null) return null;
    url.searchParams.delete("instagram");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    const messages = {
      denied:
        "Instagram connection was cancelled. You can try connecting again.",
      expired: "Instagram connection expired. Start the connection again.",
      failed: "Instagram could not be connected. Try again.",
    };
    return Object.hasOwn(messages, result) ? messages[result] : null;
  }

  function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined && text !== null) result.textContent = String(text);
    if (className) result.className = className;
    return result;
  }

  function button(text, action, className = "button secondary") {
    const result = node("button", text, className);
    result.type = "button";
    result.addEventListener("click", action);
    return result;
  }

  function link(text, href, className) {
    const result = node("a", text, className);
    result.href = href;
    return result;
  }

  function externalLink(text, value, className = "button primary") {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password)
        return null;
      const result = link(text, url.href, className);
      result.rel = "noopener noreferrer";
      return result;
    } catch {
      return null;
    }
  }

  function message(id, text) {
    const target = byId(id);
    target.textContent = text || "";
    target.hidden = !text;
  }

  function date(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "—" : dateFormat.format(parsed);
  }

  function plural(count, singular, multiple = singular + "s") {
    return (
      numberFormat.format(count) + " " + (count === 1 ? singular : multiple)
    );
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers);
    if (options.body) headers.set("content-type", "application/json");
    if (workspace?.csrfToken && options.method && options.method !== "GET")
      headers.set("x-csrf-token", workspace.csrfToken);
    const response = await fetch(path, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      if (response.status === 401 && workspace && path !== "/session")
        showSignIn("Your session ended. Sign in to continue.");
      const issues = Array.isArray(data.issues)
        ? data.issues
            .map((issue) => (typeof issue === "string" ? issue : issue.message))
            .filter(Boolean)
            .join(" ")
        : "";
      const error = new Error(
        issues ||
          data.message ||
          data.error ||
          "The request could not be completed.",
      );
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function showSignIn(text = "") {
    workspace = null;
    requestVersion++;
    byId("retry-dialog").close();
    byId("resolve-dialog").close();
    byId("sign-in").hidden = false;
    byId("navigation").hidden = true;
    byId("workspace-session").hidden = true;
    content.hidden = true;
    editor.hidden = true;
    byId("section-label").textContent = "Workspace";
    byId("connection-summary").textContent = "";
    message("sign-in-error", text);
  }

  async function openWorkspace() {
    workspace = await api("/workspace");
    byId("sign-in").hidden = true;
    byId("navigation").hidden = false;
    byId("workspace-session").hidden = false;
    byId("section-label").textContent = workspace.name || "Workspace";
    content.hidden = false;
    await showRoute();
    if (instagramFeedback) {
      message("app-error", instagramFeedback);
      instagramFeedback = null;
    }
  }

  function heading(title, action) {
    const row = node("div", undefined, "page-heading");
    row.append(node("h1", title));
    if (action) row.append(action);
    return row;
  }

  function empty(title, text, action, inline = false) {
    const surface = node("div", undefined, "surface");
    const body = node("div", undefined, "empty" + (inline ? " inline" : ""));
    body.append(node("h2", title));
    if (text) body.append(node("p", text));
    if (action) body.append(action);
    surface.append(body);
    return surface;
  }

  function metrics(items) {
    const row = node("section", undefined, "metrics");
    row.setAttribute("aria-label", "Workspace totals");
    for (const [label, count, attention] of items) {
      const item = node(
        "div",
        undefined,
        "metric" + (attention ? " attention" : ""),
      );
      item.append(
        node("strong", numberFormat.format(Number(count || 0))),
        node("span", label),
      );
      row.append(item);
    }
    return row;
  }

  function setNavigation(view) {
    for (const item of document.querySelectorAll("#navigation a")) {
      if (item.dataset.view === view) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    const titles = {
      automations: "Automations",
      conversations: "Conversations",
      accounts: "Accounts",
      operations: "Operations",
    };
    document.title = titles[view] + " · Blotato";
  }

  function go(hash) {
    if (
      editorDirty &&
      !window.confirm("Leave this automation without saving your changes?")
    )
      return;
    editorDirty = false;
    if (location.hash === hash) showRoute();
    else location.hash = hash;
  }

  function readReadiness() {
    return (
      overview?.readiness || {
        dispatchConfigured: !!workspace?.integrations?.dispatchConfigured,
        accountConnected: accounts.some((account) => account.canPublish),
        settingsUrl: workspace?.integrations?.instagramConnectUrl || null,
      }
    );
  }

  function accountReady(account) {
    return (
      !!account &&
      account.status === "active" &&
      !!account.verifiedAt &&
      !account.paused &&
      account.issue !== "permissions_required"
    );
  }

  function connectionText() {
    const connected = accounts.filter(accountReady).length;
    return connected
      ? plural(connected, "account") + " connected →"
      : "Connect Instagram →";
  }

  async function commonData() {
    const [summary, result] = await Promise.all([
      api("/operator/overview"),
      api("/operator/accounts"),
    ]);
    overview = summary;
    accounts = result.accounts || [];
    const attention = Number(summary.needsAttention || 0);
    byId("nav-attention").hidden = !attention;
    byId("nav-attention").textContent = numberFormat.format(attention);
    byId("connection-summary").textContent = connectionText();
  }

  async function showRoute() {
    if (!workspace) return;
    const hash = location.hash || "#automations";
    if (editorDirty && activeHash && hash !== activeHash) {
      if (
        !window.confirm("Leave this automation without saving your changes?")
      ) {
        history.replaceState(null, "", activeHash);
        return;
      }
      editorDirty = false;
    }
    activeHash = hash;
    const version = ++requestVersion;
    message("app-error", "");
    message("app-notice", "");
    editor.hidden = true;
    content.hidden = false;
    content.replaceChildren(node("p", "Loading…", "loading"));
    const params = new URLSearchParams(hash.slice(1));
    const isConversation = hash === "#conversations" || params.has("run");
    setNavigation(
      isConversation
        ? "conversations"
        : hash === "#accounts"
          ? "accounts"
          : hash === "#operations" || params.has("incident")
            ? "operations"
            : "automations",
    );
    try {
      await commonData();
      if (version !== requestVersion) return;
      if (params.has("run")) await showConversation(params.get("run"), version);
      else if (hash === "#new") showEditor(null);
      else if (params.has("automation"))
        await openAutomation(params.get("automation"), version);
      else if (hash === "#conversations") await showConversations(version);
      else if (hash === "#accounts") showAccounts();
      else if (params.has("incident"))
        await showIncident(params.get("incident"), version);
      else if (hash === "#operations") await showOperations(version);
      else await showAutomations(version);
    } catch (error) {
      if (version !== requestVersion || !workspace) return;
      if (error.status === 404) {
        const conversation = params.has("run");
        const incident = params.has("incident");
        content.replaceChildren(
          heading(
            incident
              ? "Operations"
              : conversation
                ? "Conversations"
                : "Automations",
          ),
          empty(
            incident
              ? "Incident unavailable"
              : conversation
                ? "Conversation unavailable"
                : "Automation unavailable",
            "This item is no longer in this workspace.",
            button(
              incident
                ? "View operations"
                : conversation
                  ? "View conversations"
                  : "View automations",
              () =>
                go(
                  incident
                    ? "#operations"
                    : conversation
                      ? "#conversations"
                      : "#automations",
                ),
            ),
          ),
        );
      } else {
        message("app-error", error.message);
        content.replaceChildren(
          empty(
            "Could not open this page",
            "Try again, or return to your automations.",
            button("Automations", () => go("#automations")),
          ),
        );
      }
    }
  }

  function operationTime(value, fallback = "Not recorded") {
    return value ? date(value) : fallback;
  }

  function operationStatus(state) {
    const labels = {
      ready: "Running",
      attention: "Needs attention",
      disabled: "Not configured",
      stale: "Stopped reporting",
      missing: "Not reporting",
      degraded: "Needs attention",
    };
    return labels[state] || "Not reporting";
  }

  function operationsTabs() {
    const filters = node("div", undefined, "filters");
    filters.setAttribute("aria-label", "Operations views");
    for (const [value, label] of [
      ["open", "Open incidents"],
      ["resolved", "Incident history"],
      ["deliveries", "Delivery queue"],
    ]) {
      const control = button(
        label,
        () => {
          operationsTab = value;
          incidentCursor = null;
          deliveryCursor = null;
          showRoute();
        },
        "filter",
      );
      control.setAttribute("aria-pressed", String(operationsTab === value));
      filters.append(control);
    }
    return filters;
  }

  function systemSummary(summary) {
    const section = node("section", undefined, "operation-health surface");
    section.setAttribute("aria-label", "Processing and notifications");
    const pipeline = summary.pipeline;
    const title =
      pipeline.state === "ready"
        ? "Processing is running"
        : pipeline.state === "disabled"
          ? "Message delivery is not configured"
          : "Processing needs attention";
    const intro = node("div", undefined, "operation-health-intro");
    intro.append(node("h2", title));
    if (pipeline.state === "disabled") {
      intro.append(
        node(
          "p",
          accounts.some(accountReady)
            ? "Ask your administrator to configure message processing before publishing automations."
            : "Connect Instagram and configure processing before publishing automations.",
        ),
        link("Open accounts →", "#accounts", "empty-link"),
      );
    } else if (pipeline.state === "attention") {
      intro.append(
        node(
          "p",
          pipeline.missingConsumers?.length
            ? "Some delivery senders are unavailable. Check processing details before retrying deliveries."
            : "Review the incidents below and check processing details for the affected service.",
        ),
      );
    } else intro.append(node("p", "Checked " + operationTime(summary.asOf)));
    section.append(intro);
    const details = node("details", undefined, "operation-details");
    details.append(node("summary", "Processing details"));
    const roles = node("dl", undefined, "operation-facts");
    const names = {
      worker: "Automation execution",
      relay: "Background delivery",
    };
    for (const role of pipeline.roles || []) {
      const item = node("div");
      const text =
        operationStatus(role.state) +
        (role.lastSeenAt ? " · Last seen " + date(role.lastSeenAt) : "");
      item.append(
        node("dt", names[role.role] || "Processing"),
        node("dd", text),
      );
      roles.append(item);
    }
    const notifications = summary.notifications;
    const channel =
      notifications.channel === "telegram"
        ? "Telegram"
        : notifications.channel === "webhook"
          ? "Webhook"
          : "Notifications";
    const channelRow = node("div");
    channelRow.append(node("dt", channel));
    const channelState = [
      !notifications.configured
        ? "Not configured"
        : !notifications.observed
          ? "Notification sender unavailable"
          : "Sender available",
      notifications.failed
        ? plural(notifications.failed, "notification") + " need attention"
        : null,
      notifications.pending
        ? plural(notifications.pending, "notification") + " waiting"
        : null,
      notifications.lastAcceptedAt
        ? "Last accepted " + date(notifications.lastAcceptedAt)
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    channelRow.append(node("dd", channelState));
    roles.append(channelRow);
    if (notifications.lastAttemptAt) {
      const attempt = node("div");
      const outcomes = {
        accepted: "Accepted by the notification service",
        unknown: "Delivery outcome unconfirmed",
        rejected: "Not accepted by the notification service",
        failed: "Delivery failed",
        retryable: "A new attempt is scheduled",
        permanent: "Delivery stopped and needs attention",
        not_sent: "Not sent",
        skipped: "Not sent",
        unconfigured: "Not configured",
      };
      attempt.append(
        node("dt", "Last notification attempt"),
        node(
          "dd",
          operationTime(notifications.lastAttemptAt) +
            (notifications.lastOutcome
              ? " · " + (outcomes[notifications.lastOutcome] || "Needs review")
              : ""),
        ),
      );
      roles.append(attempt);
    }
    details.append(roles);
    if (notifications.lastErrorCode) {
      const actions = {
        telegram_rate_limited:
          "Telegram has limited requests. Delivery will wait before another attempt.",
        telegram_chat_forbidden:
          "Add the bot to the destination and allow it to send messages.",
        telegram_token_rejected:
          "Replace the Telegram bot token in the deployment settings.",
        telegram_request_rejected:
          "Check the Telegram destination and deployment settings.",
        telegram_configuration_invalid:
          "Check the Telegram deployment settings.",
        telegram_endpoint_invalid:
          "Check the notification endpoint in deployment settings.",
        telegram_connection_unknown:
          "Telegram may have accepted the notification. Check the destination before taking further action.",
        telegram_service_unavailable:
          "The notification service is unavailable. Check the destination for a possible delivery.",
        telegram_response_invalid:
          "The notification service did not confirm a delivery outcome.",
        telegram_confirmation_invalid:
          "The notification service did not confirm a delivery outcome.",
        alert_delivery_unconfigured:
          "Configure a notification channel in the deployment settings.",
        alert_obsolete:
          "The incident recovered before its first notification was sent.",
      };
      if (actions[notifications.lastErrorCode])
        details.append(
          node(
            "p",
            actions[notifications.lastErrorCode],
            "notification-guidance",
          ),
        );
    }
    const queues = node("div", undefined, "operation-queues");
    for (const queue of summary.queues || []) {
      const row = node("div", undefined, "operation-queue-row");
      const availability = !queue.configured
        ? "Not configured"
        : queue.state !== "ready" || !queue.observed
          ? "Sender unavailable"
          : "Sender available";
      const counts = [
        queue.dead
          ? plural(queue.dead, "failed delivery", "failed deliveries")
          : null,
        queue.pending
          ? plural(queue.pending, "delivery", "deliveries") + " waiting"
          : null,
        queue.inFlight
          ? plural(queue.inFlight, "delivery", "deliveries") + " in progress"
          : null,
      ].filter(Boolean);
      const text =
        availability +
        (counts.length
          ? " · " + counts.join(" · ")
          : queue.observed && queue.state === "ready"
            ? " · Queue clear"
            : " · No queued deliveries");
      row.append(node("strong", queue.label), node("span", text));
      if (queue.oldestPendingAt && queue.pending)
        row.append(
          node("small", "Oldest waiting since " + date(queue.oldestPendingAt)),
        );
      queues.append(row);
    }
    details.append(queues);
    section.append(details);
    return section;
  }

  async function showOperations(version, older = false) {
    const params = new URLSearchParams({ limit: "20" });
    const deliveries = operationsTab === "deliveries";
    if (deliveries) {
      params.set("status", deliveryStatus);
      if (deliveryKind) params.set("kind", deliveryKind);
      if (older && deliveryCursor) params.set("cursor", deliveryCursor);
    } else {
      params.set("status", operationsTab);
      if (older && incidentCursor) params.set("cursor", incidentCursor);
    }
    const [summary, result] = await Promise.all([
      api("/operator/operations"),
      api(
        (deliveries ? "/operator/deliveries?" : "/operator/incidents?") +
          params,
      ),
    ]);
    if (version !== requestVersion) return;
    const refresh = node("div", undefined, "operations-refresh");
    refresh.append(
      node("span", "Updated " + operationTime(summary.asOf)),
      button("Refresh", () => showRoute()),
    );
    content.replaceChildren(heading("Operations", refresh));
    const failedDeliveries = summary.queues.reduce(
      (total, queue) => total + queue.dead,
      0,
    );
    if (
      summary.incidents.open ||
      summary.pipeline.unknownSends ||
      failedDeliveries
    ) {
      content.append(
        metrics([
          ["Open incidents", summary.incidents.open, true],
          ["Messages to review", summary.pipeline.unknownSends],
          ["Failed deliveries", failedDeliveries],
        ]),
      );
    }
    const updateNotice = node("div", undefined, "operation-update-notice");
    updateNotice.id = "operations-updates";
    updateNotice.hidden = true;
    updateNotice.setAttribute("role", "status");
    content.append(updateNotice, operationsTabs());
    if (deliveries) {
      deliveryRows = older
        ? Array.from(
            new Map(
              [...deliveryRows, ...result.deliveries].map((item) => [
                item.id,
                item,
              ]),
            ).values(),
          )
        : result.deliveries;
      deliveryCursor = result.nextCursor;
      renderDeliveryQueue(deliveryRows, summary);
      if (deliveryCursor)
        content.append(
          button(
            "Load earlier deliveries",
            () => loadMoreOperations(version),
            "button secondary load-more",
          ),
        );
    } else {
      incidentRows = older
        ? Array.from(
            new Map(
              [...incidentRows, ...result.incidents].map((item) => [
                item.id,
                item,
              ]),
            ).values(),
          )
        : result.incidents;
      incidentCursor = result.nextCursor;
      renderIncidents(incidentRows);
      if (incidentCursor)
        content.append(
          button(
            "Load earlier incidents",
            () => loadMoreOperations(version),
            "button secondary load-more",
          ),
        );
    }
    operationsFingerprint = operationsSignature(
      summary,
      deliveries ? deliveryRows.slice(0, 20) : incidentRows.slice(0, 20),
    );
    content.append(systemSummary(summary));
  }

  function operationsSignature(summary, rows) {
    return JSON.stringify({
      tab: operationsTab,
      status: deliveryStatus,
      kind: deliveryKind,
      incidents: summary.incidents,
      pipelineState: summary.pipeline.state,
      missingConsumers: summary.pipeline.missingConsumers,
      unknown: summary.pipeline.unknownSends,
      unrouted: summary.pipeline.unroutedEvents,
      roles: summary.pipeline.roles.map((role) => [
        role.role,
        role.state,
        role.instances,
      ]),
      queues: summary.queues.map((queue) => [
        queue.kind,
        queue.configured,
        queue.expected,
        queue.observed,
        queue.state,
        queue.pending,
        queue.dead,
        queue.inFlight,
      ]),
      notifications: [
        summary.notifications.configured,
        summary.notifications.expected,
        summary.notifications.observed,
        summary.notifications.channel,
        summary.notifications.lastErrorCode,
        summary.notifications.lastAcceptedAt,
        summary.notifications.pending,
        summary.notifications.failed,
        summary.notifications.lastAttemptAt,
        summary.notifications.lastOutcome,
      ],
      rows: rows.map((row) => [
        row.id,
        row.status,
        row.generation,
        row.lastSeenAt,
        row.resolvedAt,
      ]),
    });
  }

  async function checkOperationsUpdate() {
    if (
      !workspace ||
      location.hash !== "#operations" ||
      document.visibilityState !== "visible" ||
      operationsChecking ||
      byId("retry-dialog").open ||
      !operationsFingerprint
    )
      return;
    const version = requestVersion;
    operationsChecking = true;
    try {
      const deliveries = operationsTab === "deliveries";
      const params = new URLSearchParams({
        limit: "20",
        status: deliveries ? deliveryStatus : operationsTab,
      });
      if (deliveries && deliveryKind) params.set("kind", deliveryKind);
      const [summary, result] = await Promise.all([
        api("/operator/operations"),
        api(
          (deliveries ? "/operator/deliveries?" : "/operator/incidents?") +
            params,
        ),
      ]);
      if (version !== requestVersion || !workspace) return;
      const changed =
        operationsSignature(
          summary,
          deliveries ? result.deliveries : result.incidents,
        ) !== operationsFingerprint;
      const notice = byId("operations-updates");
      if (changed && notice) {
        notice.replaceChildren(
          node("span", "New operational activity is available."),
          button(
            "Refresh operations",
            () => showRoute(),
            "button secondary small",
          ),
        );
        notice.hidden = false;
      }
    } catch (error) {
      const notice = byId("operations-updates");
      if (version === requestVersion && workspace && notice) {
        notice.replaceChildren(
          node("span", "Updates could not be checked."),
          button(
            "Refresh operations",
            () => showRoute(),
            "button secondary small",
          ),
        );
        notice.hidden = false;
      }
    } finally {
      operationsChecking = false;
    }
  }

  async function loadMoreOperations(version) {
    try {
      await showOperations(version, true);
    } catch (error) {
      if (version === requestVersion) message("app-error", error.message);
    }
  }

  function renderIncidents(incidents) {
    if (!incidents.length) {
      content.append(
        empty(
          operationsTab === "resolved"
            ? "No resolved incidents"
            : "No open incidents",
          "",
          undefined,
          true,
        ),
      );
      return;
    }
    const list = node("section", undefined, "surface");
    list.setAttribute(
      "aria-label",
      operationsTab === "resolved" ? "Resolved incidents" : "Open incidents",
    );
    for (const incident of incidents) {
      const row = button(
        "",
        () => go("#incident=" + encodeURIComponent(incident.id)),
        "incident-row",
      );
      const body = node("div");
      body.append(
        node("strong", incident.title, "row-title"),
        node("span", incident.nextAction, "row-subtitle"),
      );
      const scope = node(
        "span",
        incident.affectedConversations
          ? plural(incident.affectedConversations, "conversation")
          : "Service incident",
        "incident-scope",
      );
      const time = node(
        "span",
        incident.status === "resolved"
          ? "Resolved " + operationTime(incident.resolvedAt)
          : "Since " + operationTime(incident.firstSeenAt),
        "incident-time",
      );
      row.append(body, scope, time, node("span", "→", "row-arrow"));
      list.append(row);
    }
    content.append(list);
  }

  function deliveryUnavailable(reason) {
    const reasons = {
      not_dead: "This delivery is already queued or complete.",
      unsupported_kind: "This delivery is managed automatically.",
      kind_not_retryable: "This delivery cannot be retried here.",
      integration_unconfigured: "Configure this integration before retrying.",
      target_missing: "The original record is no longer available.",
      missing_target: "The original record is no longer available.",
      superseded: "A newer delivery has replaced this one.",
    };
    return (
      reasons[reason] ||
      (typeof reason === "string" && reason.includes(" ")
        ? reason
        : "This delivery cannot be retried here.")
    );
  }

  function deliveryName(delivery) {
    const names = {
      "crm.lead_captured": "CRM sync",
      "metadata.hydrate": "Post details",
      "alert.notify": "Operational notification",
      "workflow.start": "Conversation start",
      "workflow.signal": "Conversation update",
    };
    return names[delivery.kind] || delivery.label;
  }

  function deliveryRow(delivery) {
    const row = node("div", undefined, "delivery-row");
    const body = node("div");
    body.append(node("strong", delivery.label, "row-title"));
    let description =
      delivery.status === "dead"
        ? "Stopped after " + plural(delivery.attempts, "attempt")
        : delivery.nextAttemptAt
          ? "Next attempt " + date(delivery.nextAttemptAt)
          : "Waiting to be processed";
    body.append(node("span", description, "row-subtitle"));
    const action = node("div", undefined, "delivery-action");
    if (delivery.canRetry) {
      const retry = button(
        "Retry delivery",
        () => openDeliveryRetry(delivery),
        "button secondary small",
      );
      retry.setAttribute("aria-label", "Retry " + deliveryName(delivery));
      action.append(retry);
    } else if (delivery.status === "dead")
      action.append(
        node(
          "span",
          deliveryUnavailable(delivery.retryUnavailableReason),
          "field-help",
        ),
      );
    if (delivery.incidentId)
      action.append(
        link(
          "View incident",
          "#incident=" + encodeURIComponent(delivery.incidentId),
          "empty-link",
        ),
      );
    row.append(
      body,
      node(
        "span",
        operationTime(delivery.finishedAt || delivery.createdAt),
        "delivery-time",
      ),
      action,
    );
    return row;
  }

  function renderDeliveryQueue(deliveries, summary) {
    const controls = node("div", undefined, "delivery-filters");
    const stateField = node("div");
    const stateLabel = node("label", "Show");
    stateLabel.htmlFor = "delivery-status";
    const states = node("select");
    states.id = "delivery-status";
    for (const [value, label] of [
      ["dead", "Failed deliveries"],
      ["pending", "Waiting deliveries"],
    ]) {
      const option = node("option", label);
      option.value = value;
      states.append(option);
    }
    states.value = deliveryStatus;
    states.addEventListener("change", () => {
      deliveryStatus = states.value;
      deliveryCursor = null;
      showRoute();
    });
    stateField.append(stateLabel, states);
    const kindField = node("div");
    const kindLabel = node("label", "Integration");
    kindLabel.htmlFor = "delivery-kind";
    const kinds = node("select");
    kinds.id = "delivery-kind";
    const all = node("option", "All integrations");
    all.value = "";
    kinds.append(all);
    for (const queue of summary.queues) {
      const option = node("option", queue.label);
      option.value = queue.kind;
      kinds.append(option);
    }
    kinds.value = deliveryKind;
    kinds.addEventListener("change", () => {
      deliveryKind = kinds.value;
      deliveryCursor = null;
      showRoute();
    });
    kindField.append(kindLabel, kinds);
    controls.append(stateField, kindField);
    content.append(controls);
    if (!deliveries.length) {
      content.append(
        empty(
          deliveryStatus === "dead"
            ? "No failed deliveries"
            : "No waiting deliveries",
          "",
          undefined,
          true,
        ),
      );
      return;
    }
    const list = node("section", undefined, "surface");
    list.setAttribute("aria-label", "Background deliveries");
    for (const delivery of deliveries) list.append(deliveryRow(delivery));
    content.append(list);
  }

  async function showIncident(id, version) {
    const result = await api("/operator/incidents/" + encodeURIComponent(id));
    if (version !== requestVersion) return;
    const incident = result.incident;
    content.replaceChildren(link("← Operations", "#operations", "back-link"));
    const title = heading(incident.title);
    title.append(
      status(incident.status === "resolved" ? "Resolved" : "Needs attention"),
    );
    content.append(title);
    if (incident.status === "open") {
      const action = node("section", undefined, "review-action");
      action.append(node("h2", "Next action"), node("p", incident.nextAction));
      if (incident.type === "connection_unauthorized")
        action.append(link("Open accounts", "#accounts", "button secondary"));
      else if (
        ["crm_delivery_failing", "outbox_dead_letter"].includes(incident.type)
      )
        action.append(
          button(
            "Review failed deliveries",
            () => {
              operationsTab = "deliveries";
              deliveryStatus = "dead";
              deliveryKind =
                incident.type === "crm_delivery_failing"
                  ? "crm.lead_captured"
                  : "";
              deliveryCursor = null;
              go("#operations");
            },
            "button secondary",
          ),
        );
      else if (incident.runIds?.length)
        action.append(
          link(
            "Open affected conversation",
            "#run=" + encodeURIComponent(incident.runIds[0]),
            "button secondary",
          ),
        );
      content.append(action);
    }
    const layout = node("div", undefined, "detail-layout");
    const history = node("ol", undefined, "timeline surface");
    history.setAttribute("aria-label", "Incident history");
    for (const entry of result.history || []) {
      const item = node("li");
      const time = node("time", date(entry.at));
      time.dateTime = entry.at;
      item.append(node("p", entry.text), time);
      history.append(item);
    }
    const facts = node("dl", undefined, "detail-facts");
    for (const [label, value] of [
      ["First recorded", operationTime(incident.firstSeenAt)],
      ["Last recorded", operationTime(incident.lastSeenAt)],
      [
        "Affected conversations",
        numberFormat.format(incident.affectedConversations),
      ],
      ["Occurrences", numberFormat.format(incident.occurrences)],
    ]) {
      const row = node("div");
      row.append(node("dt", label), node("dd", value));
      facts.append(row);
    }
    if (incident.resolvedAt) {
      const row = node("div");
      row.append(node("dt", "Resolved"), node("dd", date(incident.resolvedAt)));
      facts.append(row);
    }
    layout.append(history, facts);
    content.append(layout);
    if (result.deliveries?.length) {
      const heading = node(
        "div",
        undefined,
        "section-heading related-deliveries",
      );
      heading.append(node("h2", "Related deliveries"));
      content.append(heading);
      const deliveries = node("section", undefined, "surface");
      deliveries.setAttribute("aria-label", "Related deliveries");
      for (const delivery of result.deliveries)
        deliveries.append(deliveryRow(delivery));
      content.append(deliveries);
    }
    const technical = node("details", undefined, "diagnostics");
    technical.append(
      node("summary", "Technical details"),
      node(
        "pre",
        JSON.stringify(
          {
            incidentId: incident.id,
            type: incident.type,
            connectionId: incident.connectionId,
          },
          null,
          2,
        ),
      ),
    );
    content.append(technical);
  }

  function openDeliveryRetry(delivery) {
    retryDelivery = delivery;
    byId("retry-form").reset();
    byId("retry-title").textContent = "Retry " + deliveryName(delivery);
    message("retry-error", "");
    byId("retry-dialog").showModal();
    byId("retry-note").focus();
  }

  async function showAutomations(version) {
    const data = await api("/operator/automations");
    if (version !== requestVersion) return;
    const drafts = data.drafts || [];
    const legacy = data.automations || [];
    content.replaceChildren(
      heading(
        "Automations",
        drafts.length || legacy.length
          ? button("Create automation", () => go("#new"), "button primary")
          : null,
      ),
    );
    content.append(
      metrics([
        ["Active automations", overview.automationsActive],
        ["Conversations started", overview.conversationsStarted],
        ["Emails collected", overview.emailsCollected],
      ]),
    );
    if (!drafts.length && !legacy.length) {
      content.append(
        empty(
          "Create your first automation",
          "Save a draft now. Connect Instagram when you’re ready to publish.",
          button("Create automation", () => go("#new"), "button primary"),
        ),
      );
      return;
    }
    const head = node("div", undefined, "section-heading");
    head.append(
      node("h2", "Your automations"),
      node("p", plural(drafts.length + legacy.length, "automation")),
    );
    content.append(head);
    const surface = node("section", undefined, "surface");
    surface.setAttribute("aria-label", "Automations");
    const tableHead = node("div", undefined, "table-head");
    for (const title of ["Automation", "Account", "Status", ""])
      tableHead.append(node("span", title));
    surface.append(tableHead);
    for (const draft of drafts) surface.append(automationRow(draft, false));
    for (const automation of legacy)
      surface.append(automationRow(automation, true));
    content.append(surface);
  }

  function automationRow(automation, legacy) {
    const row = button(
      "",
      () => go("#automation=" + encodeURIComponent(automation.id)),
      "automation-row",
    );
    const title = node("div");
    title.append(node("span", automation.name, "row-title"));
    const keyword = legacy
      ? automation.definition?.trigger?.keyword
      : automation.content?.keyword;
    title.append(
      node(
        "span",
        keyword ? "Comments containing “" + keyword + "”" : "Keyword not set",
        "row-subtitle",
      ),
    );
    const account = accounts.find(
      (item) =>
        item.id === (automation.connectionId || automation.connection_id),
    );
    const state = legacy
      ? automation.status === "active"
        ? "Published"
        : "Paused"
      : draftStatus(automation);
    row.append(
      title,
      node(
        "span",
        account?.displayName ||
          account?.accountId ||
          automation.connectionName ||
          "Not selected",
        "automation-account row-subtitle",
      ),
      status(state),
      node("span", "→", "row-arrow"),
    );
    return row;
  }

  function draftStatus(draft) {
    if (draft.status === "paused") return "Paused";
    if (draft.publishedRevision && draft.publishedRevision < draft.revision)
      return "Unpublished changes";
    return draft.status === "published" ? "Published" : "Draft";
  }

  function status(label) {
    const text = node("span", undefined, "row-state");
    const dot = node(
      "i",
      undefined,
      "state-dot" +
        (label === "Published" || label === "Completed"
          ? " active"
          : label === "Needs review" || label === "Needs attention"
            ? " review"
            : ""),
    );
    dot.setAttribute("aria-hidden", "true");
    text.append(dot, document.createTextNode(label));
    return text;
  }

  async function openAutomation(id, version) {
    const result = await api("/operator/automations/" + encodeURIComponent(id));
    if (version !== requestVersion) return;
    if (result.draft) showEditor(result.draft);
    else showCustomAutomation(result.automation || result);
  }

  function showCustomAutomation(automation) {
    content.replaceChildren(link("← Automations", "#automations", "back-link"));
    content.append(heading(automation.name));
    const intro = node(
      "p",
      "This automation uses a custom sequence. Its published definition is preserved.",
      "version-info",
    );
    content.append(intro);
    const steps = node("div", undefined, "surface definition-view");
    const stepLabels = {
      reply_comment: "Public comment reply",
      send_private_reply: "Private reply",
      send_message: "Private message",
      await_input: "Wait for an email",
    };
    for (const step of automation.definition?.steps || []) {
      const item = node("div", undefined, "definition-step");
      item.append(
        node("strong", stepLabels[step.type] || "Custom step"),
        node(
          "p",
          step.text || (step.timeout ? "Reply window: " + step.timeout : ""),
        ),
      );
      steps.append(item);
    }
    content.append(steps);
    const diagnostics = node("details", undefined, "diagnostics");
    diagnostics.append(
      node("summary", "Definition and version"),
      node("pre", JSON.stringify(automation, null, 2)),
    );
    content.append(diagnostics);
  }

  function showEditor(draft) {
    currentDraft = draft;
    form.reset();
    const data = draft?.content || {};
    byId("automation-name").value = draft?.name || "";
    byId("keyword").value = data.keyword || "";
    byId("public-reply").value = data.publicReply || "";
    byId("email-prompt").value = data.emailPrompt || "";
    byId("link-text").value = data.linkText || "";
    byId("link-url").value = data.linkUrl || "";
    byId("clarification").value = data.clarificationText || "";
    byId("timeout").value = data.timeoutHours ?? 72;
    byId("clarifications").value = String(data.maxClarifications ?? 1);
    byId("account").replaceChildren(node("option", "Choose an account"));
    byId("account").firstElementChild.value = "";
    for (const account of accounts) {
      const option = node("option", account.displayName || account.accountId);
      option.value = account.id;
      option.disabled =
        !accountReady(account) && account.id !== draft?.connectionId;
      byId("account").append(option);
    }
    byId("account").value = draft?.connectionId || "";
    const scope = editor.querySelector(".scope-line");
    scope.textContent = data.postIds?.length
      ? "Applies to " + plural(data.postIds.length, "selected post") + "."
      : "Applies to all posts on the selected account.";
    byId("editor-title").textContent = draft?.name || "New automation";
    byId("editor-state").textContent = draft
      ? draftStatus(draft) + " · Saved " + date(draft.updatedAt)
      : "Draft";
    byId("account").disabled = accounts.length === 0;
    byId("account-help").hidden = true;
    content.hidden = true;
    editor.hidden = false;
    savedForm = JSON.stringify(editorValues());
    editorDirty = false;
    updateEditor();
    byId("automation-name").focus({ preventScroll: true });
  }

  function editorValues() {
    const contentValues = {};
    for (const name of [
      "keyword",
      "publicReply",
      "emailPrompt",
      "linkText",
      "linkUrl",
      "clarificationText",
    ]) {
      const value = form.elements.namedItem(name).value.trim();
      if (value) contentValues[name] = value;
    }
    const timeout = byId("timeout").value;
    if (timeout) contentValues.timeoutHours = Number(timeout);
    contentValues.maxClarifications = Number(byId("clarifications").value);
    if (currentDraft?.content?.postIds)
      contentValues.postIds = currentDraft.content.postIds;
    return {
      name: byId("automation-name").value.trim(),
      connectionId: byId("account").value || null,
      content: contentValues,
    };
  }

  function editorComplete() {
    const values = editorValues();
    const fields = values.content;
    return !!(
      values.name &&
      fields.keyword &&
      fields.publicReply &&
      fields.emailPrompt &&
      fields.linkText &&
      fields.linkUrl &&
      fields.timeoutHours >= 1 &&
      fields.timeoutHours <= 720 &&
      (fields.maxClarifications === 0 || fields.clarificationText)
    );
  }

  function updateEditor() {
    byId("clarification-field").hidden = byId("clarifications").value === "0";
    if (currentDraft)
      editorDirty = JSON.stringify(editorValues()) !== savedForm;
    else
      editorDirty =
        !!byId("automation-name").value ||
        Object.values(editorValues().content).some(
          (value) => typeof value === "string" && value,
        );
    byId("editor-state").textContent = editorDirty
      ? "Unsaved changes"
      : currentDraft
        ? draftStatus(currentDraft) + " · Saved " + date(currentDraft.updatedAt)
        : "Draft";
    byId("save-draft").disabled =
      editorBusy || !editorValues().name || (!!currentDraft && !editorDirty);
    const ready = readReadiness();
    const selected = accounts.find(
      (account) => account.id === byId("account").value,
    );
    const requirements = node("ul", undefined, "requirements");
    const checks = [
      [editorComplete(), "Complete the message sequence"],
      [accountReady(selected), "Connect an Instagram account"],
      [!!ready.dispatchConfigured, "Message delivery configured"],
    ];
    for (const [passed, text] of checks) {
      const item = node("li", undefined, passed ? "ready" : "pending");
      if (!passed && text === "Connect an Instagram account")
        item.append(
          link("Connect an Instagram account →", "#accounts", "empty-link"),
        );
      else item.textContent = (passed ? "✓ " : "") + text;
      requirements.append(item);
    }
    byId("publish-requirements").replaceChildren(requirements);
    byId("publish-explanation").hidden = !ready.canPublish;
    byId("publish-explanation").textContent =
      "New matching comments will start this sequence.";
    const alreadyPublished =
      currentDraft?.status === "published" &&
      currentDraft.publishedRevision === currentDraft.revision &&
      !editorDirty;
    byId("publish-automation").textContent = alreadyPublished
      ? "Published"
      : currentDraft?.publishedRevision
        ? "Publish changes"
        : "Publish automation";
    const paused = currentDraft?.status === "paused";
    byId("publish-automation").disabled =
      editorBusy ||
      alreadyPublished ||
      (paused && !editorDirty) ||
      !checks.every(([passed]) => passed);
    byId("publish-automation").hidden = paused && !editorDirty;
    const toggle = byId("toggle-automation");
    toggle.hidden = !currentDraft?.automationId || editorDirty;
    toggle.textContent = paused ? "Resume automation" : "Pause automation";
    toggle.disabled =
      editorBusy || (paused && !checks.every(([passed]) => passed));
  }

  async function saveDraft(duringPublish = false) {
    if (editorBusy && !duringPublish) return null;
    if (!byId("automation-name").reportValidity()) return null;
    editorBusy = true;
    updateEditor();
    const version = requestVersion;
    const values = editorValues();
    try {
      if (!currentDraft && values.connectionId === null)
        delete values.connectionId;
      const result = await api(
        currentDraft
          ? "/operator/automations/" + encodeURIComponent(currentDraft.id)
          : "/operator/automations",
        {
          method: currentDraft ? "PATCH" : "POST",
          body: JSON.stringify({
            ...values,
            ...(currentDraft
              ? { expectedRevision: currentDraft.revision }
              : {}),
          }),
        },
      );
      if (version !== requestVersion) return null;
      const draft = result.draft || result;
      currentDraft = draft;
      savedForm = JSON.stringify(editorValues());
      editorDirty = false;
      history.replaceState(
        null,
        "",
        "#automation=" + encodeURIComponent(draft.id),
      );
      activeHash = location.hash;
      byId("editor-title").textContent = draft.name;
      updateEditor();
      message("app-error", "");
      message("app-notice", "Draft saved.");
      return draft;
    } catch (error) {
      if (version !== requestVersion) return null;
      message(
        "app-error",
        error.status === 409
          ? "This automation changed in another window. Reload it before saving again."
          : error.message,
      );
      updateEditor();
      return null;
    } finally {
      if (!duringPublish) {
        editorBusy = false;
        updateEditor();
      }
    }
  }

  async function publishDraft() {
    if (editorBusy || !form.reportValidity()) return;
    editorBusy = true;
    updateEditor();
    const version = requestVersion;
    try {
      const draft =
        !currentDraft || editorDirty ? await saveDraft(true) : currentDraft;
      if (!draft || version !== requestVersion) return;
      const result = await api(
        "/operator/automations/" + encodeURIComponent(draft.id) + "/publish",
        {
          method: "POST",
          body: JSON.stringify({ expectedRevision: draft.revision }),
        },
      );
      if (version !== requestVersion) return;
      currentDraft = result.draft;
      savedForm = JSON.stringify(editorValues());
      editorDirty = false;
      updateEditor();
      message("app-error", "");
      message(
        "app-notice",
        "Automation published. New matching comments will start this sequence.",
      );
    } catch (error) {
      if (version === requestVersion) message("app-error", error.message);
    } finally {
      editorBusy = false;
      updateEditor();
    }
  }

  async function toggleAutomation() {
    if (!currentDraft?.automationId || editorBusy) return;
    editorBusy = true;
    updateEditor();
    const action = currentDraft.status === "paused" ? "enable" : "disable";
    try {
      await api(
        "/automations/" +
          encodeURIComponent(currentDraft.automationId) +
          "/" +
          action,
        { method: "POST" },
      );
      await showRoute();
      message(
        "app-notice",
        action === "enable"
          ? "Automation resumed."
          : "Automation paused. Existing conversations can continue.",
      );
    } catch (error) {
      message("app-error", error.message);
    } finally {
      editorBusy = false;
      updateEditor();
    }
  }

  async function connectInstagram(control, connectionId) {
    control.disabled = true;
    const original = control.textContent;
    control.textContent = "Opening Instagram…";
    try {
      const result = await api("/integrations/instagram/connect", {
        method: "POST",
        ...(connectionId ? { body: JSON.stringify({ connectionId }) } : {}),
      });
      const url = new URL(result.url);
      if (
        url.protocol !== "https:" ||
        !["www.instagram.com", "instagram.com"].includes(url.hostname) ||
        url.username ||
        url.password
      )
        throw new Error("The Instagram connection could not be opened.");
      location.assign(url.href);
    } catch (error) {
      message("app-error", error.message);
      control.disabled = false;
      control.textContent = original;
    }
  }

  async function disconnectInstagram(account, control) {
    const name = account.displayName || account.accountId;
    if (
      !window.confirm(
        "Disconnect “" +
          name +
          "”? New automated messages from this account will stop. A message already being sent may still arrive.",
      )
    )
      return;
    control.disabled = true;
    try {
      await api(
        "/integrations/instagram/accounts/" +
          encodeURIComponent(account.id) +
          "/disconnect",
        { method: "POST", body: JSON.stringify({}) },
      );
      await showRoute();
      message(
        "app-notice",
        name + " disconnected. New automated messages have stopped.",
      );
    } catch (error) {
      message("app-error", error.message);
      control.disabled = false;
    }
  }

  function showAccounts() {
    const integration = workspace.integrations || {};
    const nativeLogin = !!integration.instagramLoginConfigured;
    const ready = readReadiness();
    let connect = null;
    if (nativeLogin) {
      connect = button(
        accounts.length ? "Connect another account" : "Connect Instagram",
        () => connectInstagram(connect),
        "button primary",
      );
    } else if (ready.settingsUrl || integration.instagramConnectUrl) {
      connect = externalLink(
        "Connect Instagram",
        ready.settingsUrl || integration.instagramConnectUrl,
      );
    }
    content.replaceChildren(heading("Accounts", connect));
    if (!accounts.length) {
      content.append(
        empty(
          "Connect Instagram to publish",
          nativeLogin
            ? "Sign in to Instagram and choose the professional account you want to use. Your saved automations will be ready to publish after the connection is confirmed."
            : "Instagram sign-in needs to be configured for this installation. You can create and save your automation while the connection is being set up.",
        ),
      );
    } else {
      const surface = node("section", undefined, "surface");
      surface.setAttribute("aria-label", "Connected accounts");
      for (const account of accounts) {
        const row = node("div", undefined, "account-row");
        const details = node("div");
        details.append(
          node(
            "strong",
            account.displayName || account.accountId,
            "account-name",
          ),
        );
        if (account.issue) {
          const issues = {
            reconnect_required:
              "Reconnect this account to continue sending messages.",
            paused: "Automated messages are paused for this account.",
            permissions_required: "Messaging permissions need to be confirmed.",
            delivery_unconfigured:
              "Account connected. Message delivery still needs to be configured.",
          };
          details.append(
            node(
              "p",
              issues[account.issue] || "This connection needs attention.",
            ),
          );
        } else if (account.verifiedAt)
          details.append(
            node("p", "Connection verified " + date(account.verifiedAt)),
          );
        const state =
          account.status === "disconnected"
            ? "Disconnected"
            : account.status === "unauthorized"
              ? "Reconnect required"
              : account.paused
                ? "Paused"
                : accountReady(account)
                  ? "Connected"
                  : "Not connected";
        const action = node("div", undefined, "account-actions");
        action.append(node("span", state, "account-state"));
        if (
          nativeLogin &&
          account.source === "native" &&
          ["unauthorized", "disconnected"].includes(account.status)
        ) {
          const reconnect = button(
            "Reconnect",
            () => connectInstagram(reconnect, account.id),
            "button secondary small",
          );
          reconnect.setAttribute(
            "aria-label",
            "Reconnect " + (account.displayName || account.accountId),
          );
          action.append(reconnect);
        }
        if (account.canDisconnect === true) {
          const disconnect = button(
            "Disconnect",
            () => disconnectInstagram(account, disconnect),
            "button secondary small",
          );
          disconnect.setAttribute(
            "aria-label",
            "Disconnect " + (account.displayName || account.accountId),
          );
          action.append(disconnect);
        }
        row.append(details, action);
        surface.append(row);
      }
      content.append(surface);
    }
    if (!nativeLogin) {
      const setup = node("details", undefined, "diagnostics");
      setup.append(node("summary", "Connection setup"));
      const instructions = node("div", undefined, "setup-instructions");
      instructions.append(
        node(
          "p",
          "The installation administrator needs to configure a Meta app with Instagram messaging permissions. Store its app ID and secret in the server configuration.",
        ),
      );
      const paths = integration.instagramSetup || {};
      if (paths.callbackPath) {
        instructions.append(
          node(
            "p",
            "Add your public HTTPS address followed by this callback path to the Meta app:",
          ),
          node("code", paths.callbackPath),
        );
      }
      if (paths.webhookPath) {
        instructions.append(
          node(
            "p",
            "Register the webhook at your public HTTPS address followed by:",
          ),
          node("code", paths.webhookPath),
        );
      }
      instructions.append(
        node("p", "Reload this page once the configuration has been saved."),
      );
      setup.append(instructions);
      content.append(setup);
    }
  }

  async function showConversations(version, older = false) {
    const params = new URLSearchParams();
    if (conversationFilter === "review") params.set("needsReview", "true");
    else if (conversationFilter === "waiting")
      params.set("status", "waiting_input");
    else if (conversationFilter === "completed")
      params.set("status", "completed");
    if (older && conversationCursor) params.set("cursor", conversationCursor);
    const data = await api("/runs?" + params);
    if (version !== requestVersion) return;
    conversationRows = older
      ? Array.from(
          new Map(
            [...conversationRows, ...data.runs].map((run) => [run.id, run]),
          ).values(),
        )
      : data.runs;
    conversationCursor = data.nextCursor || null;
    content.replaceChildren(
      heading(
        "Conversations",
        button("Refresh", () => showRoute()),
      ),
    );
    content.append(
      metrics([
        ["Conversations started", overview.conversationsStarted],
        ["Emails collected", overview.emailsCollected],
        ["Need review", overview.needsAttention, true],
      ]),
    );
    const filters = node("div", undefined, "filters");
    filters.setAttribute("aria-label", "Filter conversations");
    for (const [value, label] of [
      ["all", "All conversations"],
      ["review", "Needs review"],
      ["waiting", "Waiting for reply"],
      ["completed", "Completed"],
    ]) {
      const filter = button(
        label,
        () => {
          conversationFilter = value;
          conversationCursor = null;
          showRoute();
        },
        "filter",
      );
      filter.setAttribute("aria-pressed", String(value === conversationFilter));
      filters.append(filter);
    }
    content.append(filters);
    if (!conversationRows.length) {
      content.append(
        empty(
          conversationFilter === "all"
            ? "No conversations yet"
            : "No conversations in this view",
          conversationFilter === "all"
            ? "Conversations appear when someone comments on a post covered by a published automation."
            : "Choose another view to see your conversations.",
        ),
      );
      return;
    }
    const surface = node("section", undefined, "surface");
    surface.setAttribute("aria-label", "Conversations");
    for (const run of conversationRows) {
      const row = button(
        "",
        () => go("#run=" + encodeURIComponent(run.id)),
        "conversation-row",
      );
      const title = node("div");
      title.append(
        node(
          "span",
          run.participant_name ||
            run.automation_name ||
            "Instagram conversation",
          "row-title",
        ),
        node(
          "span",
          run.participant_name
            ? run.automation_name
            : "Started " + date(run.created_at),
          "row-subtitle",
        ),
      );
      row.append(
        title,
        node("span", date(run.created_at), "conversation-date row-subtitle"),
        status(runLabels[run.status] || "In progress"),
        node("span", "→", "row-arrow"),
      );
      surface.append(row);
    }
    content.append(surface);
    if (conversationCursor)
      content.append(
        button(
          "Load earlier conversations",
          () =>
            showConversations(version, true).catch((error) =>
              message("app-error", error.message),
            ),
          "button secondary load-more",
        ),
      );
  }

  function timelineText(entry, intents) {
    const intent = intents.find((item) => item.id === entry.refs?.intentId);
    const action =
      intent?.kind === "comment_reply"
        ? "Comment reply"
        : intent?.kind === "private_reply"
          ? "Email question"
          : "Private message";
    switch (entry.type) {
      case "comment.received":
        return "Comment received";
      case "run.created":
        return "Comment matched this automation";
      case "send.accepted":
        return action + " accepted by Instagram";
      case "send.unknown":
        return "Message needs a delivery check";
      case "send.resolved":
        return "Delivery outcome confirmed";
      case "send.blocked":
        return "Message could not be sent";
      case "send.cancelled":
        return "Message stopped";
      case "send.rejected":
        return "Instagram rejected the message";
      case "wait.active":
        return "Waiting for an email address";
      case "input.accepted":
        return "Email address received";
      case "input.rejected":
        return "Reply did not contain a valid email";
      case "input.clarification_requested":
        return "Email clarification requested";
      case "wait.expired":
        return "Reply window ended";
      case "wait.cancelled":
        return "Waiting stopped";
      case "crm.pending":
        return "Lead queued for CRM";
      case "crm.synced":
        return "Lead synced to CRM";
      case "crm.failed":
        return "CRM sync needs attention";
      case "run.finished":
        return entry.text.includes("completed")
          ? "Conversation completed"
          : entry.text.includes("expired")
            ? "Conversation closed without a reply"
            : entry.text.includes("cancelled")
              ? "Conversation stopped"
              : "Conversation needs attention";
      default:
        return null;
    }
  }

  async function showConversation(id, version) {
    const [detail, history] = await Promise.all([
      api("/runs/" + encodeURIComponent(id)),
      api("/runs/" + encodeURIComponent(id) + "/timeline"),
    ]);
    if (version !== requestVersion) return;
    const { run, intents = [], waits = [], lead } = detail;
    content.replaceChildren(
      link("← Conversations", "#conversations", "back-link"),
    );
    const title = node("div", undefined, "detail-top");
    const names = node("div");
    names.append(
      node(
        "h1",
        run.participant_name || run.automation_name || "Instagram conversation",
        "detail-title",
      ),
      node(
        "p",
        run.participant_name
          ? run.automation_name
          : "Instagram conversation · " + date(run.created_at),
        "detail-meta",
      ),
    );
    title.append(names, status(runLabels[run.status] || "In progress"));
    content.append(title);
    const uncertain = intents.filter((intent) => intent.status === "unknown");
    for (const intent of uncertain) {
      const callout = node("div", undefined, "review-action");
      callout.append(
        node("h2", "Check whether this message was sent"),
        node(
          "p",
          "Instagram did not confirm the result. Check the conversation before allowing another attempt.",
        ),
        button(
          "Review message",
          () => openResolution(intent.id),
          "button secondary",
        ),
      );
      content.append(callout);
    }
    const layout = node("div", undefined, "detail-layout");
    const timelineSurface = node("section", undefined, "surface");
    timelineSurface.setAttribute("aria-label", "Conversation history");
    const timeline = node("ol", undefined, "timeline");
    for (const entry of history.entries || []) {
      const text = timelineText(entry, intents);
      if (!text) continue;
      const item = node("li");
      const time = node("time", date(entry.at));
      time.dateTime = entry.at;
      item.append(node("p", text), time);
      timeline.append(item);
    }
    if (!timeline.children.length)
      timeline.append(node("li", "No recorded activity."));
    timelineSurface.append(timeline);
    const facts = node("aside");
    const list = node("dl", undefined, "detail-facts");
    const rows = [["Started", date(run.created_at)]];
    if (lead)
      rows.push(
        ["Email", lead.email],
        [
          "CRM",
          lead.crm_status === "synced"
            ? "Synced"
            : lead.crm_status === "failed"
              ? "Needs attention"
              : "Waiting to sync",
        ],
      );
    const activeWait = waits.find((wait) => wait.status === "active");
    if (activeWait?.deadline)
      rows.push(["Reply by", date(activeWait.deadline)]);
    if (run.finished_at) rows.push(["Finished", date(run.finished_at)]);
    for (const [label, value] of rows) {
      const item = node("div");
      item.append(node("dt", label), node("dd", value));
      list.append(item);
    }
    facts.append(list);
    if (!run.finished_at)
      facts.append(
        button(
          "Stop conversation",
          () => stopConversation(run.id),
          "button danger load-more",
        ),
      );
    layout.append(timelineSurface, facts);
    content.append(layout);
    const diagnostics = node("details", undefined, "diagnostics");
    diagnostics.append(
      node("summary", "Technical details"),
      node(
        "pre",
        JSON.stringify(
          {
            runId: run.id,
            participantId: run.participant_id,
            status: run.status,
            reason: run.status_reason,
            intents,
            waits,
          },
          null,
          2,
        ),
      ),
    );
    content.append(diagnostics);
  }

  async function stopConversation(id) {
    if (
      !window.confirm(
        "Stop this automation for the conversation? A message already being sent may still arrive.",
      )
    )
      return;
    try {
      await api("/runs/" + encodeURIComponent(id) + "/cancel", {
        method: "POST",
        body: JSON.stringify({ reason: "operator" }),
      });
      await showRoute();
      message(
        "app-notice",
        "Stop requested. Refresh the conversation to see the final result.",
      );
    } catch (error) {
      message("app-error", error.message);
    }
  }

  function openResolution(id) {
    resolutionIntentId = id;
    byId("resolve-form").reset();
    message("resolve-error", "");
    byId("resolve-dialog").showModal();
  }

  byId("close-retry").addEventListener("click", () =>
    byId("retry-dialog").close(),
  );
  byId("retry-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const delivery = retryDelivery;
    const note = byId("retry-note").value.trim();
    if (!delivery || !note) {
      message("retry-error", "Add a reason for retrying this delivery.");
      return;
    }
    const version = requestVersion;
    byId("submit-retry").disabled = true;
    message("retry-error", "");
    try {
      await api(
        "/operator/deliveries/" + encodeURIComponent(delivery.id) + "/retry",
        {
          method: "POST",
          body: JSON.stringify({
            expectedGeneration: delivery.generation,
            note,
          }),
        },
      );
      byId("retry-dialog").close();
      if (version !== requestVersion || !workspace) return;
      await showRoute();
      message(
        "app-notice",
        deliveryName(delivery) + " returned to the delivery queue.",
      );
    } catch (error) {
      message(
        "retry-error",
        error.status === 409
          ? "This delivery changed. Close this dialog and refresh the queue before retrying."
          : error.message,
      );
    } finally {
      byId("submit-retry").disabled = false;
    }
  });

  byId("sign-in-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    byId("sign-in-submit").disabled = true;
    message("sign-in-error", "");
    try {
      await api("/session", {
        method: "POST",
        body: JSON.stringify({ token: byId("access-key").value }),
      });
      byId("sign-in-form").reset();
      await openWorkspace();
    } catch (error) {
      message("sign-in-error", error.message);
    } finally {
      byId("sign-in-submit").disabled = false;
    }
  });
  byId("sign-out").addEventListener("click", async () => {
    if (editorDirty && !window.confirm("Sign out without saving your changes?"))
      return;
    try {
      await api("/session", { method: "DELETE" });
      editorDirty = false;
      showSignIn();
      message("app-notice", "");
      message("app-error", "");
    } catch (error) {
      message("app-error", error.message);
    }
  });
  form.addEventListener("input", updateEditor);
  form.addEventListener("change", updateEditor);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveDraft();
  });
  byId("save-draft").addEventListener("click", () => saveDraft());
  byId("publish-automation").addEventListener("click", publishDraft);
  byId("toggle-automation").addEventListener("click", toggleAutomation);
  byId("close-resolve").addEventListener("click", () =>
    byId("resolve-dialog").close(),
  );
  byId("resolve-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    byId("save-resolution").disabled = true;
    try {
      await api(
        "/intents/" + encodeURIComponent(resolutionIntentId) + "/resolve",
        {
          method: "POST",
          body: JSON.stringify({
            resolution: new FormData(event.currentTarget).get("resolution"),
            note: byId("resolution-note").value.trim(),
          }),
        },
      );
      byId("resolve-dialog").close();
      await showRoute();
      message("app-notice", "Delivery decision saved.");
    } catch (error) {
      message("resolve-error", error.message);
    } finally {
      byId("save-resolution").disabled = false;
    }
  });
  document.addEventListener("click", (event) => {
    const anchor = event.target.closest('a[href^="#"]');
    if (
      !anchor ||
      anchor.classList.contains("skip") ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    go(anchor.getAttribute("href"));
  });
  window.addEventListener("hashchange", showRoute);
  window.addEventListener("beforeunload", (event) => {
    if (editorDirty) event.preventDefault();
  });
  window.setInterval(checkOperationsUpdate, 15_000);
  openWorkspace().catch((error) => {
    if (error.status === 401) showSignIn();
    else {
      content.replaceChildren(
        empty(
          "Workspace unavailable",
          "Check the connection and try again.",
          button("Try again", () => location.reload()),
        ),
      );
      message("app-error", error.message);
    }
  });
})();
