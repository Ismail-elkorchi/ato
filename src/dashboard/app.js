import "@ismail-elkorchi/ui-primitives/register.js";
import "@ismail-elkorchi/ui-shell/register.js";
import { createBreakpointObserver } from "@ismail-elkorchi/ui-tokens";

const ICON_PATHS = {
  queue: "M4 6h16M4 12h16M4 18h16",
  active: "M8 5l11 7-11 7z",
  blocked: "M6 6h12v12H6z",
  done: "M5 13l4 4L19 7",
  runs: "M12 6v6l4 2",
  blackboard: "M4 5h16v10H4zM4 15h16",
  targets: "M12 2v4m0 12v4M2 12h4m12 0h4",
  settings: "M12 8a4 4 0 100 8 4 4 0 000-8zM4 12h2m12 0h2M12 4v2m0 12v2",
};

const VIEW_ITEMS = [
  { id: "queue", label: "Queue", description: "All queue items." },
  { id: "active", label: "Active", description: "Active items." },
  { id: "blocked", label: "Blocked", description: "Blocked items." },
  { id: "done", label: "Done", description: "Completed items." },
  { id: "runs", label: "Runs", description: "Run history." },
  {
    id: "blackboard",
    label: "Blackboard",
    description: "Signals and snapshots.",
  },
  { id: "targets", label: "Targets", description: "Target registry." },
  { id: "settings", label: "Settings", description: "Read-only config." },
];

const STATUS_ORDER = new Map([
  ["active", 0],
  ["queued", 1],
  ["blocked", 2],
  ["dropped", 3],
  ["done", 4],
]);

const TARGET_ORDER = new Map([
  ["exact", 0],
  ["range", 1],
  ["milestone", 2],
  ["unbounded", 3],
]);

const PRIORITY_ORDER = new Map([
  ["P0", 0],
  ["P1", 1],
  ["P2", 2],
  ["P3", 3],
  ["P4", 4],
]);

const QUEUE_PAGE_SIZE = 25;

const STATUS_TRANSITIONS = new Map([
  ["queued", new Set(["active", "blocked", "dropped"])],
  ["active", new Set(["blocked", "done", "dropped"])],
  ["blocked", new Set(["queued", "active", "dropped"])],
  ["done", new Set()],
  ["dropped", new Set()],
]);

const state = {
  view: "queue",
  detailId: null,
  detailTab: "summary",
  targetSelection: null,
  status: null,
  queueItems: [],
  runs: [],
  blackboard: null,
  targets: null,
  config: null,
  contractIndex: null,
  activeBundle: null,
  detailErrors: [],
  viewErrors: {},
  loading: {
    queue: false,
    runs: false,
    blackboard: false,
    targets: false,
    settings: false,
    active: false,
  },
  filters: {
    status: "all",
    priority: "all",
    target: "all",
    tags: [],
    runsKind: "all",
  },
  sort: {
    mode: "deterministic",
    direction: "asc",
  },
  contractRefs: [],
  contractSections: [],
  pagination: {
    queue: {
      page: 1,
      pageSize: QUEUE_PAGE_SIZE,
    },
  },
};

const appRoot = document.getElementById("app");
if (!appRoot) {
  throw new Error("Dashboard root element not found.");
}

const shell = mountShell(appRoot);
const { main, activityBar, nav, statusBar } = shell;

function resetTargetData() {
  state.queueItems = [];
  state.runs = [];
  state.blackboard = null;
  state.targets = null;
  state.config = null;
  state.contractIndex = null;
  state.contractSections = [];
  state.activeBundle = null;
  state.detailId = null;
  state.detailErrors = [];
  state.viewErrors = {};
  state.loading.queue = false;
  state.loading.runs = false;
  state.loading.blackboard = false;
  state.loading.targets = false;
  state.loading.settings = false;
  state.loading.active = false;
  state.pagination.queue.page = 1;
}

const boot = async () => {
  createBreakpointObserver();
  syncRouteFromHash();
  await loadStatus();
  await loadViewData({ force: true });
  render();
};

boot();

window.addEventListener("hashchange", async () => {
  syncRouteFromHash();
  await loadViewData({ force: false });
  render();
});

function mountShell(container) {
  container.innerHTML = `
    <uik-shell-layout class="dashboard-shell">
      <uik-shell-activity-bar
        slot="activity-bar"
        aria-label="Primary navigation"
      ></uik-shell-activity-bar>
      <uik-shell-sidebar
        slot="primary-sidebar"
        heading="ATO Dashboard"
        isBodyPadded
        isBodyScrollable
      >
        <uik-nav data-dashboard-nav aria-label="Sections"></uik-nav>
      </uik-shell-sidebar>
      <main
        slot="main-content"
        id="dashboard-main"
        class="dashboard-main"
        tabindex="-1"
      ></main>
      <uik-shell-status-bar
        slot="status-bar"
        class="dashboard-status"
      ></uik-shell-status-bar>
    </uik-shell-layout>
  `;

  const activity = container.querySelector("uik-shell-activity-bar");
  const navList = container.querySelector("uik-nav");
  const mainContent = container.querySelector("#dashboard-main");
  const status = container.querySelector("uik-shell-status-bar");

  const items = VIEW_ITEMS.map((item) => ({
    id: item.id,
    label: item.label,
    icon: ICON_PATHS[item.id],
  }));

  if (activity) {
    activity.items = items;
    activity.addEventListener("activity-bar-select", (event) => {
      const id = event.detail?.id;
      if (id) setView(id);
    });
  }

  if (navList) {
    navList.items = VIEW_ITEMS.map((item) => ({
      id: item.id,
      label: item.label,
      href: `#${item.id}`,
    }));
    navList.addEventListener("nav-select", (event) => {
      event.preventDefault();
      const id = event.detail?.id;
      if (id) setView(id);
    });
  }

  return {
    activityBar: activity,
    nav: navList,
    main: mainContent,
    statusBar: status,
  };
}

function setView(view) {
  if (!VIEW_ITEMS.find((item) => item.id === view)) return;
  state.view = view;
  state.detailId = null;
  state.detailTab = "summary";
  state.pagination.queue.page = 1;
  window.location.hash = `#${view}`;
}

function syncRouteFromHash() {
  const raw = window.location.hash.replace(/^#/, "");
  const [view, detailId] = raw.split("/");
  const matched = VIEW_ITEMS.find((item) => item.id === view);
  state.view = matched?.id ?? "queue";
  state.detailId = detailId || null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildApiUrl(path, params = {}) {
  const query = new URLSearchParams();
  const target = state.targetSelection;
  if (target) query.set("target", target);
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") return;
    query.set(key, String(value));
  });
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    const error = payload?.error ?? {
      message: response.statusText || "Request failed",
    };
    const normalized = {
      type: error.type ?? "request",
      message: error.message ?? "Request failed",
      suggestion: error.suggestion ?? null,
      details: error.details ?? null,
    };
    throw normalized;
  }
  return payload;
}

function formatTarget(target) {
  if (!target) return "unbounded";
  const selector = target.selector ?? target.kind ?? "unbounded";
  if (selector === "unbounded") return "unbounded";
  return `${selector}:${target.value}`;
}

function targetSpecificity(target) {
  const selector = target?.selector ?? target?.kind ?? "unbounded";
  return TARGET_ORDER.get(selector) ?? TARGET_ORDER.get("unbounded");
}

function statusRank(status) {
  return STATUS_ORDER.get(status) ?? STATUS_ORDER.get("done");
}

function priorityRank(priority) {
  if (typeof priority === "number") return priority;
  return PRIORITY_ORDER.get(priority) ?? PRIORITY_ORDER.get("P4");
}

function formatDate(value) {
  if (!value) return "-";
  return value;
}

function formatDuration(value) {
  if (typeof value !== "number") return "-";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

function parseLines(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatLines(list) {
  return Array.isArray(list) ? list.join("\n") : "";
}

function uniqueSorted(list) {
  return Array.from(new Set(list)).sort((a, b) => a.localeCompare(b));
}

function renderBadge(label, variant) {
  return `<uik-badge variant="${variant}">${escapeHtml(label)}</uik-badge>`;
}

function renderErrorBanner(error) {
  if (!error) return "";
  const details = error.details
    ? `<details class="dashboard-error-details">
        <summary>Details</summary>
        <pre class="dashboard-code-block">${escapeHtml(
          JSON.stringify(error.details, null, 2),
        )}</pre>
      </details>`
    : "";
  const suggestion = error.suggestion
    ? `<div class="dashboard-field-help">${escapeHtml(error.suggestion)}</div>`
    : "";
  return `
    <uik-alert variant="danger">
      <span slot="title">${escapeHtml(error.type || "Error")}</span>
      <div>${escapeHtml(error.message)}</div>
      ${suggestion}
      ${details}
    </uik-alert>
  `;
}

function updateNavigation() {
  if (activityBar) activityBar.activeId = state.view;
  if (nav) nav.currentId = state.view;
}

function updateStatusBar() {
  if (!statusBar) return;
  const protocolOk = state.status?.protocol?.ok ?? false;
  const lock = state.status?.lock;
  if (lock?.isLocked) {
    statusBar.tone = "danger";
    statusBar.message = "Write lock active";
  } else if (!protocolOk) {
    statusBar.tone = "danger";
    statusBar.message = "Protocol mismatch";
  } else {
    statusBar.tone = "info";
    statusBar.message = "Ready";
  }
  const targetId = state.status?.target?.id ?? "unresolved";
  const root = state.status?.target?.root ?? "unknown root";
  statusBar.meta = `Target: ${targetId} | ${root}`;
}

function render() {
  updateNavigation();
  updateStatusBar();
  if (!main) return;
  const header = renderHeader();
  const view = renderView();
  main.innerHTML = `${header}${view}`;
  wireHeaderActions();
  wireView();
}

function renderHeader() {
  const view = VIEW_ITEMS.find((item) => item.id === state.view);
  const target = state.status?.target;
  const protocol = state.status?.protocol;
  const lock = state.status?.lock;
  const lastGate = state.status?.lastGate;
  const targets = state.status?.targets?.available ?? [];

  const protocolBadge = renderBadge(
    protocol?.ok ? "OK" : "Mismatch",
    protocol?.ok ? "secondary" : "danger",
  );
  const lockBadge = renderBadge(
    lock?.isLocked ? "Locked" : "Free",
    lock?.isLocked ? "danger" : "secondary",
  );

  const gateLabel = lastGate
    ? `${lastGate.mode ?? "?"} (${lastGate.ok ? "ok" : "fail"})`
    : "No runs";

  const availableIds = new Set(targets.map((entry) => entry.id));
  const targetOptionsList = [...targets];
  if (target?.root && target?.id && !availableIds.has(target.id)) {
    targetOptionsList.unshift({
      id: target.id,
      value: target.root,
      label: `${target.id} (external)`,
    });
  }

  const targetOptions = targetOptionsList.length
    ? targetOptionsList
        .map((entry) => {
          const value = entry.value ?? entry.id;
          const label = entry.label ?? entry.id;
          return `<option value="${escapeHtml(value)}">${escapeHtml(
            label,
          )}</option>`;
        })
        .join("")
    : `<option value="">No targets</option>`;

  return `
    <section class="dashboard-header">
      ${renderErrorBanner(state.viewErrors.header)}
      <div class="dashboard-header-top">
        <div class="dashboard-header-title">
          <uik-heading level="2">${escapeHtml(view?.label ?? "View")}</uik-heading>
          <span>${escapeHtml(view?.description ?? "")}</span>
        </div>
        <div class="dashboard-header-actions">
          <uik-select data-target-select>
            <span slot="label">Target</span>
            ${targetOptions}
          </uik-select>
          <uik-button data-action="refresh" variant="secondary">Refresh</uik-button>
          <uik-button data-action="pack" variant="ghost">Pack</uik-button>
          <uik-button data-action="gate" variant="ghost">Gate Run</uik-button>
        </div>
      </div>
      <div class="dashboard-status-grid">
        <uik-surface variant="card" class="dashboard-status-card">
          <div class="dashboard-panel-title">
            <uik-text>Target</uik-text>
          </div>
          <div>${escapeHtml(target?.id ?? "unresolved")}</div>
          <div class="dashboard-status-meta">${escapeHtml(
            target?.root ?? "Select a target to continue.",
          )}</div>
        </uik-surface>
        <uik-surface variant="card" class="dashboard-status-card">
          <div class="dashboard-panel-title">
            <uik-text>Protocol</uik-text>
            ${protocolBadge}
          </div>
          <div class="dashboard-status-meta">${escapeHtml(
            protocol?.meta?.cliVersion ?? "unknown cli",
          )}</div>
        </uik-surface>
        <uik-surface variant="card" class="dashboard-status-card">
          <div class="dashboard-panel-title">
            <uik-text>Lock</uik-text>
            ${lockBadge}
          </div>
          <div class="dashboard-status-meta">${escapeHtml(
            lock?.isLocked
              ? `Held by ${lock.lock?.pid ?? "unknown"}`
              : "No lock detected",
          )}</div>
        </uik-surface>
        <uik-surface variant="card" class="dashboard-status-card">
          <div class="dashboard-panel-title">
            <uik-text>Last gate</uik-text>
          </div>
          <div>${escapeHtml(gateLabel)}</div>
          <div class="dashboard-status-meta">${escapeHtml(
            lastGate?.ts ?? "No gate recorded.",
          )}</div>
        </uik-surface>
      </div>
    </section>
  `;
}

function renderView() {
  switch (state.view) {
    case "queue":
    case "active":
    case "blocked":
    case "done":
      return renderQueueView();
    case "runs":
      return renderRunsView();
    case "blackboard":
      return renderBlackboardView();
    case "targets":
      return renderTargetsView();
    case "settings":
      return renderSettingsView();
    default:
      return `<p class="dashboard-empty">Unknown view.</p>`;
  }
}

function renderQueueView() {
  const viewStatus =
    state.view === "queue"
      ? "all"
      : state.view === "done"
        ? "done"
        : state.view;
  const queueError = state.viewErrors.queue;
  if (state.detailId) {
    return renderQueueDetail();
  }
  const items = filterQueueItems(viewStatus);
  const pageSize = state.pagination.queue.pageSize;
  const totalItems = items.length;
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(
    Math.max(state.pagination.queue.page, 1),
    pageCount,
  );
  if (page !== state.pagination.queue.page) {
    state.pagination.queue.page = page;
  }
  const start = (page - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  const rows = pageItems.length
    ? pageItems.map((item) => renderQueueRow(item)).join("")
    : `
      <tr>
        <td colspan="8" class="dashboard-empty">No queue items.</td>
      </tr>
    `;

  const targetSelectors = collectTargetSelectors(state.queueItems);
  const priorityOptions = ["all", "P0", "P1", "P2", "P3", "P4"];
  const statusOptions = [
    "all",
    "queued",
    "active",
    "blocked",
    "done",
    "dropped",
  ];

  const targetOptions = ["all", ...targetSelectors]
    .map(
      (target) =>
        `<option value="${escapeHtml(target)}">${escapeHtml(target)}</option>`,
    )
    .join("");

  const prioritySelect = priorityOptions
    .map((option) => `<option value="${option}">${escapeHtml(option)}</option>`)
    .join("");

  const statusSelect = statusOptions
    .map((option) => `<option value="${option}">${escapeHtml(option)}</option>`)
    .join("");

  const activeContext = state.view === "active" ? renderActiveContext() : "";
  const showPagination = pageCount > 1;
  const pagination = showPagination
    ? `
      <div class="dashboard-pagination">
        <uik-pagination
          data-queue-pagination
          page="${page}"
          page-count="${pageCount}"
          total="${totalItems}"
          aria-label="Queue pagination"
        ></uik-pagination>
      </div>
    `
    : "";

  return `
    <section class="dashboard-panel">
      ${renderErrorBanner(queueError)}
      <div class="dashboard-panel-header">
        <div class="dashboard-panel-title">
          <uik-heading level="3">Queue</uik-heading>
          <uik-badge variant="secondary">${state.queueItems.length}</uik-badge>
        </div>
        <div class="dashboard-inline-actions">
          <uik-button data-action="queue-new" variant="secondary">New item</uik-button>
          <uik-button data-action="queue-refresh" variant="ghost">Refresh</uik-button>
        </div>
      </div>
      <div class="dashboard-filters">
        <div class="dashboard-filter-group">
          <span class="dashboard-filter-label">Status</span>
          <uik-select data-filter="status">${statusSelect}</uik-select>
        </div>
        <div class="dashboard-filter-group">
          <span class="dashboard-filter-label">Priority</span>
          <uik-select data-filter="priority">${prioritySelect}</uik-select>
        </div>
        <div class="dashboard-filter-group">
          <span class="dashboard-filter-label">Target selector</span>
          <uik-select data-filter="target">${targetOptions}</uik-select>
        </div>
        <div class="dashboard-filter-group">
          <span class="dashboard-filter-label">Tags</span>
          <uik-combobox data-filter="tags" placeholder="Add tag"></uik-combobox>
          <div class="dashboard-chip-list" data-tag-list>
            ${state.filters.tags
              .map((tag) => renderTagChip(tag, "filter"))
              .join("")}
          </div>
        </div>
        <div class="dashboard-filter-group">
          <span class="dashboard-filter-label">Sort</span>
          <uik-select data-filter="sort">
            <option value="deterministic">Deterministic</option>
            <option value="created">Created</option>
            <option value="priority">Priority</option>
          </uik-select>
        </div>
      </div>
      <uik-surface variant="card" bordered>
        <div class="dashboard-panel">
          <table class="dashboard-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Target</th>
                <th>Tags</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
          ${pagination}
        </div>
      </uik-surface>
      ${activeContext}
    </section>
  `;
}

function renderActiveContext() {
  const bundle = state.activeBundle;
  if (!bundle) return "";
  const lessons = bundle.lessons ?? [];
  const patterns = bundle.patterns ?? [];
  const signals = bundle.signals ?? [];

  const lessonList = lessons.length
    ? lessons
        .map(
          (lesson) =>
            `<li>${escapeHtml(lesson.id)}: ${escapeHtml(
              lesson.pattern ?? "",
            )}</li>`,
        )
        .join("")
    : `<li class="dashboard-empty">No lessons.</li>`;

  const patternList = patterns.length
    ? patterns
        .map(
          (pattern) =>
            `<li>${escapeHtml(pattern.id)}: ${escapeHtml(
              pattern.title ?? "",
            )}</li>`,
        )
        .join("")
    : `<li class="dashboard-empty">No patterns.</li>`;

  const signalList = signals.length
    ? signals
        .map(
          (signal) =>
            `<li>${escapeHtml(signal.ts)}: ${escapeHtml(
              signal.summary ?? "",
            )}</li>`,
        )
        .join("")
    : `<li class="dashboard-empty">No signals.</li>`;

  return `
    <div class="dashboard-status-grid">
      <uik-surface variant="card" class="dashboard-status-card">
        <uik-heading level="5">Lessons</uik-heading>
        <ul class="dashboard-compact-list">${lessonList}</ul>
      </uik-surface>
      <uik-surface variant="card" class="dashboard-status-card">
        <uik-heading level="5">Patterns</uik-heading>
        <ul class="dashboard-compact-list">${patternList}</ul>
      </uik-surface>
      <uik-surface variant="card" class="dashboard-status-card">
        <uik-heading level="5">Blackboard signals</uik-heading>
        <ul class="dashboard-compact-list">${signalList}</ul>
      </uik-surface>
    </div>
  `;
}

function renderQueueRow(item) {
  const statusBadge = renderBadge(
    item.status,
    badgeVariantForStatus(item.status),
  );
  const priorityBadge = renderBadge(String(item.priority), "outline");
  const tags = (item.tags ?? [])
    .map((tag) => renderBadge(tag, "secondary"))
    .join(" ");
  const canStart = canTransition(item.status, "active");
  const canBlock = canTransition(item.status, "blocked");
  const canDone = canTransition(item.status, "done");
  const disabled = isWriteDisabled();
  const startDisabled = disabled || !canStart ? "disabled" : "";
  const blockDisabled = disabled || !canBlock ? "disabled" : "";
  const doneDisabled = disabled || !canDone ? "disabled" : "";
  return `
    <tr>
      <td>${escapeHtml(item.id)}</td>
      <td>${escapeHtml(item.title)}</td>
      <td>${statusBadge}</td>
      <td>${priorityBadge}</td>
      <td>${escapeHtml(formatTarget(item.target))}</td>
      <td>${tags || "-"}</td>
      <td>${escapeHtml(formatDate(item.updated_at))}</td>
      <td>
        <div class="dashboard-table-actions">
          <uik-button
            size="sm"
            variant="ghost"
            data-action="queue-open"
            data-id="${escapeHtml(item.id)}"
          >Open</uik-button>
          <uik-button
            size="sm"
            variant="secondary"
            data-action="queue-start"
            data-id="${escapeHtml(item.id)}"
            ${startDisabled}
          >Start</uik-button>
          <uik-button
            size="sm"
            variant="ghost"
            data-action="queue-block"
            data-id="${escapeHtml(item.id)}"
            ${blockDisabled}
          >Block</uik-button>
          <uik-button
            size="sm"
            variant="solid"
            data-action="queue-done"
            data-id="${escapeHtml(item.id)}"
            ${doneDisabled}
          >Done</uik-button>
        </div>
      </td>
    </tr>
  `;
}

function renderQueueDetail() {
  const item = getDetailItem();
  if (!item) {
    return `<p class="dashboard-empty">Queue item not found.</p>`;
  }
  state.contractRefs = hydrateContractRefs(item);
  const writeDisabled = isWriteDisabled();
  const canStart = canTransition(item.status, "active");
  const canBlock = canTransition(item.status, "blocked");
  const canDone = canTransition(item.status, "done");
  const saveDisabled = writeDisabled ? "disabled" : "";
  const startDisabled = writeDisabled || !canStart ? "disabled" : "";
  const blockDisabled = writeDisabled || !canBlock ? "disabled" : "";
  const doneDisabled = writeDisabled || !canDone ? "disabled" : "";
  const errors = state.detailErrors
    .map((error) => `- ${escapeHtml(error.message)}`)
    .join("\n");
  const errorBanner = errors
    ? `
      <uik-alert variant="danger">
        <span slot="title">Validation errors</span>
        <pre class="dashboard-code-block">${errors}</pre>
      </uik-alert>
    `
    : "";

  const statusBadge = renderBadge(
    item.status,
    badgeVariantForStatus(item.status),
  );

  return `
    <section class="dashboard-panel">
      ${renderErrorBanner(state.viewErrors.detail)}
      ${errorBanner}
      <div class="dashboard-panel-header">
        <div class="dashboard-panel-title">
          <uik-heading level="3">${escapeHtml(item.id)}</uik-heading>
          ${statusBadge}
        </div>
        <div class="dashboard-inline-actions">
          <uik-button data-action="queue-back" variant="ghost">Back</uik-button>
          <uik-button data-action="queue-save" variant="secondary" ${saveDisabled}>Save</uik-button>
          <uik-button data-action="queue-start" variant="ghost" ${startDisabled}>Start</uik-button>
          <uik-button data-action="queue-block" variant="ghost" ${blockDisabled}>Block</uik-button>
          <uik-button data-action="queue-done" variant="solid" ${doneDisabled}>Done</uik-button>
          <uik-button data-action="reflect" variant="ghost" ${saveDisabled}>Reflect record</uik-button>
        </div>
      </div>
      <uik-tabs data-detail-tabs>
        <uik-tab value="summary">Summary</uik-tab>
        <uik-tab value="details">Details</uik-tab>
        <uik-tab value="reflection">Reflection</uik-tab>
        <uik-tab value="history">History</uik-tab>
        <uik-tab-panel value="summary">
          <div class="dashboard-tab-panel">
            <uik-description-list class="dashboard-description-list" density="compact">
              <dt>Title</dt>
              <dd>
                <uik-input data-field="title" aria-label="Title"></uik-input>
              </dd>
              <dt>Type</dt>
              <dd>
                <uik-select data-field="type" aria-label="Type">
                  ${[
                    "bug",
                    "debt",
                    "waiver",
                    "quality-debt",
                    "feature",
                    "doc",
                    "contract",
                    "tooling",
                    "investigation",
                  ]
                    .map((type) => `<option value="${type}">${type}</option>`)
                    .join("")}
                </uik-select>
              </dd>
              <dt>Priority</dt>
              <dd>
                <uik-select data-field="priority" aria-label="Priority">
                  ${["P0", "P1", "P2", "P3", "P4"]
                    .map(
                      (priority) =>
                        `<option value="${priority}">${priority}</option>`,
                    )
                    .join("")}
                </uik-select>
              </dd>
              <dt>Target</dt>
              <dd>
                <div class="dashboard-field-group">
                  <uik-select
                    data-field="target-selector"
                    aria-label="Target selector"
                  >
                    <option value="exact">exact</option>
                    <option value="range">range</option>
                    <option value="milestone">milestone</option>
                    <option value="unbounded">unbounded</option>
                  </uik-select>
                  <uik-input
                    data-field="target-value"
                    aria-label="Target value"
                  ></uik-input>
                </div>
              </dd>
              <dt>Tags</dt>
              <dd>
                <uik-combobox
                  data-field="tags"
                  placeholder="Add tag"
                  aria-label="Tags"
                ></uik-combobox>
                <div class="dashboard-chip-list" data-tag-editor>
                  ${(item.tags ?? []).map((tag) => renderTagChip(tag, "detail")).join("")}
                </div>
                <span class="dashboard-field-help">
                  Tags must be lowercase; use commas or add individually.
                </span>
              </dd>
            </uik-description-list>
          </div>
        </uik-tab-panel>
        <uik-tab-panel value="details">
          <div class="dashboard-tab-panel">
            <uik-textarea data-field="rationale">
              <span slot="label">Rationale</span>
            </uik-textarea>
            <uik-textarea data-field="problem">
              <span slot="label">Problem</span>
            </uik-textarea>
            <uik-textarea data-field="outcome">
              <span slot="label">Outcome</span>
            </uik-textarea>
            <uik-textarea data-field="plan-steps">
              <span slot="label">Plan steps (one per line)</span>
            </uik-textarea>
            <uik-textarea data-field="plan-rationale">
              <span slot="label">Plan rationale</span>
            </uik-textarea>
            <div class="dashboard-detail-grid">
              <uik-textarea data-field="acceptance">
                <span slot="label">Acceptance criteria (one per line)</span>
              </uik-textarea>
              <uik-textarea data-field="inputs">
                <span slot="label">Inputs (one per line)</span>
              </uik-textarea>
              <uik-textarea data-field="deliverables">
                <span slot="label">Deliverables (one per line)</span>
              </uik-textarea>
            </div>
            <div class="dashboard-detail-grid">
              <uik-textarea data-field="scope">
                <span slot="label">Scope (one per line)</span>
              </uik-textarea>
              <uik-textarea data-field="scope-paths">
                <span slot="label">Scope paths (one per line)</span>
              </uik-textarea>
              <uik-textarea data-field="risks">
                <span slot="label">Risks (one per line)</span>
              </uik-textarea>
              <uik-textarea data-field="runbook">
                <span slot="label">Runbook (one per line)</span>
              </uik-textarea>
              <uik-select data-field="effort">
                <span slot="label">Effort</span>
                <option value="">Unspecified</option>
                <option value="S">S</option>
                <option value="M">M</option>
                <option value="L">L</option>
              </uik-select>
            </div>
            <uik-textarea data-field="notes">
              <span slot="label">Notes</span>
            </uik-textarea>
            <div class="dashboard-detail-grid">
              <uik-textarea data-field="deps">
                <span slot="label">Dependencies (one per line)</span>
              </uik-textarea>
              <uik-textarea data-field="evidence">
                <span slot="label">Evidence (one per line)</span>
              </uik-textarea>
            </div>
            <div class="dashboard-panel">
              <div class="dashboard-panel-title">
                <uik-text>Contract refs</uik-text>
              </div>
              <uik-combobox data-field="contract-refs" placeholder="Add contract ref"></uik-combobox>
              <div class="dashboard-chip-list" data-contract-ref-list>
                ${renderContractRefChips()}
              </div>
              <div class="dashboard-panel">
                ${renderContractSections()}
              </div>
            </div>
          </div>
        </uik-tab-panel>
        <uik-tab-panel value="reflection">
          <div class="dashboard-tab-panel">
            <div class="dashboard-detail-grid">
              <uik-textarea data-field="delta-inputs">
                <span slot="label">Delta scan inputs</span>
              </uik-textarea>
              <uik-textarea data-field="delta-findings">
                <span slot="label">Delta scan findings</span>
              </uik-textarea>
              <uik-textarea data-field="delta-evidence">
                <span slot="label">Delta scan evidence</span>
              </uik-textarea>
            </div>
            <div class="dashboard-detail-grid">
              <uik-textarea data-field="system-inputs">
                <span slot="label">System scan inputs</span>
              </uik-textarea>
              <uik-textarea data-field="system-findings">
                <span slot="label">System scan findings</span>
              </uik-textarea>
              <uik-textarea data-field="system-evidence">
                <span slot="label">System scan evidence</span>
              </uik-textarea>
            </div>
          </div>
        </uik-tab-panel>
        <uik-tab-panel value="history">
          <div class="dashboard-tab-panel">
            <div class="dashboard-detail-grid">
              <div class="dashboard-field">
                <span class="dashboard-field-label">Created</span>
                <div>${escapeHtml(formatDate(item.created_at))}</div>
              </div>
              <div class="dashboard-field">
                <span class="dashboard-field-label">Updated</span>
                <div>${escapeHtml(formatDate(item.updated_at))}</div>
              </div>
              <div class="dashboard-field">
                <span class="dashboard-field-label">Completed</span>
                <div>${escapeHtml(formatDate(item.completed_at))}</div>
              </div>
            </div>
          </div>
        </uik-tab-panel>
      </uik-tabs>
    </section>
  `;
}

function renderContractRefChips() {
  const refs = state.contractRefs;
  if (!refs.length) {
    return `<span class="dashboard-empty">No contract refs added.</span>`;
  }
  return refs
    .filter((ref) => ref.kind === "contract")
    .map((ref) => renderTagChip(ref.label, "contract", ref.index))
    .join("");
}

function hydrateContractRefs(item) {
  const refs = item.spec?.contract_refs ?? [];
  return refs.map((ref, index) => {
    if (typeof ref === "string") {
      return {
        kind: "contract",
        doc: null,
        section: ref,
        label: ref,
        index,
      };
    }
    return {
      kind: "contract",
      doc: ref.doc,
      section: ref.section,
      label: `${ref.section} ${ref.doc}`,
      index,
    };
  });
}

function renderContractSections() {
  if (!state.contractSections.length) {
    return `<span class="dashboard-empty">No sections loaded.</span>`;
  }
  return state.contractSections
    .map(
      (section) => `
        <uik-surface variant="muted" bordered>
          <div class="dashboard-panel">
            <uik-heading level="5">${escapeHtml(section.entry.heading)}</uik-heading>
            <pre class="dashboard-code-block">${escapeHtml(section.content)}</pre>
          </div>
        </uik-surface>
      `,
    )
    .join("");
}

function renderTagChip(tag, role, index = null) {
  const dataIndex = index !== null ? `data-index="${index}"` : "";
  return `
    <div class="dashboard-chip" ${dataIndex} data-role="${role}">
      ${renderBadge(tag, "secondary")}
      <uik-button size="icon" variant="ghost" data-action="chip-remove">
        <span aria-hidden="true">×</span>
        <uik-visually-hidden>Remove</uik-visually-hidden>
      </uik-button>
    </div>
  `;
}

function renderRunsView() {
  const error = state.viewErrors.runs;
  const entries = filterRuns();
  const rows = entries.length
    ? entries.map((entry) => renderRunEntry(entry)).join("")
    : `<p class="dashboard-empty">No run entries.</p>`;

  return `
    <section class="dashboard-panel">
      ${renderErrorBanner(error)}
      <div class="dashboard-panel-header">
        <div class="dashboard-panel-title">
          <uik-heading level="3">Runs log</uik-heading>
          <uik-badge variant="secondary">${state.runs.length}</uik-badge>
        </div>
        <div class="dashboard-inline-actions">
          <uik-select data-filter="runs-kind">
            <option value="all">All kinds</option>
            ${[
              "gate_run",
              "queue_transition",
              "queue_update",
              "reflect",
              "lesson_add",
              "pattern_add",
              "pack",
              "lint",
              "dev_run",
            ]
              .map(
                (kind) =>
                  `<option value="${kind}">${escapeHtml(kind)}</option>`,
              )
              .join("")}
          </uik-select>
          <uik-button data-action="runs-refresh" variant="ghost">Refresh</uik-button>
        </div>
      </div>
      <div class="dashboard-timeline">${rows}</div>
    </section>
  `;
}

function renderRunEntry(entry) {
  const commands = (entry.commands ?? [])
    .map(
      (command) => `
        <li>
          <div>${escapeHtml(command.cmd)}</div>
          <div class="dashboard-status-meta">
            ${escapeHtml(command.cwd)} | exit ${command.exitCode} | ${formatDuration(
              command.durationMs,
            )}
          </div>
        </li>
      `,
    )
    .join("");
  const artifacts = (entry.artifacts ?? [])
    .map(
      (artifact) => `
        <li>
          <a href="${buildApiUrl("/api/files", { path: artifact })}" target="_blank" rel="noopener">
            ${escapeHtml(artifact)}
          </a>
        </li>
      `,
    )
    .join("");
  return `
    <details class="dashboard-timeline-entry">
      <summary>
        <strong>${escapeHtml(entry.kind)}</strong>
        ${escapeHtml(entry.summary ?? "")}
        <span class="dashboard-status-meta">${escapeHtml(entry.ts)}</span>
      </summary>
      <div class="dashboard-panel">
        <div class="dashboard-status-meta">Target: ${escapeHtml(
          entry.target_id ?? "unknown",
        )}</div>
        ${
          commands
            ? `<div>
          <strong>Commands</strong>
          <ul class="dashboard-compact-list">${commands}</ul>
        </div>`
            : ""
        }
        ${
          artifacts
            ? `<div>
          <strong>Artifacts</strong>
          <ul class="dashboard-compact-list">${artifacts}</ul>
        </div>`
            : ""
        }
      </div>
    </details>
  `;
}

function renderBlackboardView() {
  const error = state.viewErrors.blackboard;
  const signals = state.blackboard?.signals ?? [];
  const grouped = groupBlackboardSignals(signals);
  const rows = grouped.length
    ? grouped.map((group) => renderBlackboardGroup(group)).join("")
    : `<p class="dashboard-empty">No signals.</p>`;

  return `
    <section class="dashboard-panel">
      ${renderErrorBanner(error)}
      <div class="dashboard-panel-header">
        <div class="dashboard-panel-title">
          <uik-heading level="3">Blackboard</uik-heading>
        </div>
        <div class="dashboard-inline-actions">
          <uik-button data-action="bb-refresh" variant="ghost">Refresh</uik-button>
        </div>
      </div>
      <div class="dashboard-status-grid">${rows}</div>
    </section>
  `;
}

function groupBlackboardSignals(signals) {
  const grouped = new Map();
  for (const signal of signals) {
    const ts = signal.ts ?? "";
    const date = ts ? ts.slice(0, 10) : "unknown";
    const kind = signal.kind ?? "signal";
    const key = `${date}::${kind}`;
    if (!grouped.has(key)) {
      grouped.set(key, { date, kind, signals: [] });
    }
    grouped.get(key).signals.push(signal);
  }
  return Array.from(grouped.values()).sort((a, b) => {
    const dateDiff = String(b.date).localeCompare(String(a.date));
    if (dateDiff !== 0) return dateDiff;
    return String(a.kind).localeCompare(String(b.kind));
  });
}

function renderBlackboardGroup(group) {
  const entries = [...group.signals].sort((a, b) =>
    String(b.ts ?? "").localeCompare(String(a.ts ?? "")),
  );
  const entryList = entries
    .map(
      (signal) => `
        <li>
          <div>${escapeHtml(signal.summary)}</div>
          <div class="dashboard-status-meta">${escapeHtml(signal.ts)}</div>
        </li>
      `,
    )
    .join("");

  return `
    <uik-surface variant="card" class="dashboard-status-card">
      <div class="dashboard-panel-title">
        <uik-text>${escapeHtml(group.date)}</uik-text>
        ${renderBadge(group.kind, "outline")}
      </div>
      <ul class="dashboard-compact-list">${entryList}</ul>
    </uik-surface>
  `;
}

function renderTargetsView() {
  const error = state.viewErrors.targets;
  const entries = state.targets?.entries ?? [];
  const rows = entries.length
    ? entries
        .map(
          (entry) => `
            <tr>
              <td>${escapeHtml(entry.id)}</td>
              <td>${escapeHtml(entry.root)}</td>
              <td>${escapeHtml(entry.storeDir)}</td>
              <td>${renderBadge(entry.fingerprintStatus, entry.fingerprintStatus === "match" ? "secondary" : "danger")}</td>
            </tr>
          `,
        )
        .join("")
    : `
      <tr>
        <td colspan="4" class="dashboard-empty">No targets configured.</td>
      </tr>
    `;

  return `
    <section class="dashboard-panel">
      ${renderErrorBanner(error)}
      <div class="dashboard-panel-header">
        <div class="dashboard-panel-title">
          <uik-heading level="3">Targets</uik-heading>
        </div>
        <uik-button data-action="targets-refresh" variant="ghost">Refresh</uik-button>
      </div>
      <uik-surface variant="card" bordered>
        <table class="dashboard-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Root</th>
              <th>Store</th>
              <th>Fingerprint</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </uik-surface>
    </section>
  `;
}

function renderSettingsView() {
  const error = state.viewErrors.settings;
  const config = state.config?.config;
  const agents = state.config?.agents;

  return `
    <section class="dashboard-panel">
      ${renderErrorBanner(error)}
      <div class="dashboard-panel-header">
        <div class="dashboard-panel-title">
          <uik-heading level="3">Settings</uik-heading>
        </div>
        <uik-button data-action="settings-refresh" variant="ghost">Refresh</uik-button>
      </div>
      <uik-surface variant="card" bordered>
        <div class="dashboard-panel">
          <uik-heading level="5">Protocol metadata</uik-heading>
          <uik-code-block
            class="dashboard-json-output"
            copy
            aria-label="Protocol metadata"
          >
            ${escapeHtml(JSON.stringify(agents ?? {}, null, 2))}
          </uik-code-block>
        </div>
      </uik-surface>
      <uik-surface variant="card" bordered>
        <div class="dashboard-panel">
          <uik-heading level="5">Config (.ato/config.json)</uik-heading>
          <uik-code-block
            class="dashboard-json-output"
            copy
            aria-label="Config data"
          >
            ${escapeHtml(JSON.stringify(config ?? {}, null, 2))}
          </uik-code-block>
        </div>
      </uik-surface>
    </section>
  `;
}

function wireHeaderActions() {
  const targetSelect = main.querySelector("[data-target-select]");
  if (targetSelect) {
    const targetId = state.targetSelection ?? state.status?.target?.id ?? "";
    targetSelect.value = targetId;
    targetSelect.disabled = !state.status?.targets?.available?.length;
    targetSelect.addEventListener("change", async () => {
      state.targetSelection = targetSelect.value || null;
      resetTargetData();
      await loadStatus();
      await loadViewData({ force: true });
      render();
    });
  }

  const refresh = main.querySelector('[data-action="refresh"]');
  if (refresh) {
    refresh.addEventListener("click", async () => {
      await loadViewData({ force: true });
      render();
    });
  }

  const pack = main.querySelector('[data-action="pack"]');
  if (pack) {
    pack.disabled = isWriteDisabled();
    pack.addEventListener("click", () => openPackDialog());
  }

  const gate = main.querySelector('[data-action="gate"]');
  if (gate) {
    gate.disabled = isWriteDisabled();
    gate.addEventListener("click", () => openGateDialog());
  }
}

function wireView() {
  switch (state.view) {
    case "queue":
    case "active":
    case "blocked":
    case "done":
      wireQueueView();
      break;
    case "runs":
      wireRunsView();
      break;
    case "blackboard":
      wireBlackboardView();
      break;
    case "targets":
      wireTargetsView();
      break;
    case "settings":
      wireSettingsView();
      break;
    default:
      break;
  }
}

function wireQueueView() {
  if (state.detailId) {
    wireQueueDetail();
    return;
  }
  const viewStatus =
    state.view === "queue"
      ? "all"
      : state.view === "done"
        ? "done"
        : state.view;
  const statusFilter = main.querySelector('[data-filter="status"]');
  const priorityFilter = main.querySelector('[data-filter="priority"]');
  const targetFilter = main.querySelector('[data-filter="target"]');
  const tagFilter = main.querySelector('[data-filter="tags"]');
  const sortFilter = main.querySelector('[data-filter="sort"]');
  const tagList = main.querySelector("[data-tag-list]");

  if (statusFilter) {
    statusFilter.value =
      viewStatus === "all" ? state.filters.status : viewStatus;
    statusFilter.disabled = viewStatus !== "all";
    if (viewStatus === "all") {
      statusFilter.addEventListener("change", () => {
        state.filters.status = statusFilter.value;
        state.pagination.queue.page = 1;
        render();
      });
    }
  }

  if (priorityFilter) {
    priorityFilter.value = state.filters.priority;
    priorityFilter.addEventListener("change", () => {
      state.filters.priority = priorityFilter.value;
      state.pagination.queue.page = 1;
      render();
    });
  }

  if (targetFilter) {
    targetFilter.value = state.filters.target;
    targetFilter.addEventListener("change", () => {
      state.filters.target = targetFilter.value;
      state.pagination.queue.page = 1;
      render();
    });
  }

  if (sortFilter) {
    sortFilter.value = state.sort.mode;
    sortFilter.addEventListener("change", () => {
      state.sort.mode = sortFilter.value;
      state.pagination.queue.page = 1;
      render();
    });
  }

  if (tagFilter) {
    const items = collectTags(state.queueItems).map((tag) => ({
      id: tag,
      label: tag,
      value: tag,
    }));
    tagFilter.items = items;
    tagFilter.addEventListener("combobox-select", (event) => {
      const value = event.detail?.value ?? event.detail?.item?.value;
      if (!value) return;
      state.filters.tags = uniqueSorted([...state.filters.tags, value]);
      state.pagination.queue.page = 1;
      render();
    });
  }

  if (tagList) {
    tagList
      .querySelectorAll('[data-action="chip-remove"]')
      .forEach((button) => {
        button.addEventListener("click", () => {
          const chip = button.closest("[data-role='filter']");
          const badge = chip?.querySelector("uik-badge");
          const tag = badge?.textContent?.trim();
          if (!tag) return;
          state.filters.tags = state.filters.tags.filter(
            (entry) => entry !== tag,
          );
          state.pagination.queue.page = 1;
          render();
        });
      });
  }

  const pagination = main.querySelector("[data-queue-pagination]");
  if (pagination) {
    pagination.addEventListener("pagination-change", (event) => {
      const page = event.detail?.page;
      if (!page) return;
      state.pagination.queue.page = page;
      render();
    });
  }

  main.querySelectorAll('[data-action^="queue-"]').forEach((button) => {
    const action = button.getAttribute("data-action");
    const id = button.getAttribute("data-id");
    button.addEventListener("click", () => {
      handleQueueAction(action, id);
    });
  });
}

function wireQueueDetail() {
  const tabs = main.querySelector("[data-detail-tabs]");
  if (tabs) {
    tabs.activeId = state.detailTab;
    tabs.addEventListener("tabs-select", (event) => {
      state.detailTab = event.detail?.id ?? "summary";
    });
  }

  const item = getDetailItem();
  if (!item) return;

  setFieldValue("title", item.title);
  setFieldValue("type", item.type);
  setFieldValue("priority", String(item.priority));
  setFieldValue(
    "target-selector",
    item.target?.selector ?? item.target?.kind ?? "unbounded",
  );
  setFieldValue("target-value", item.target?.value ?? "");
  setFieldValue("rationale", item.details?.rationale ?? "");
  setFieldValue("problem", item.spec?.problem ?? "");
  setFieldValue("outcome", item.spec?.outcome ?? "");
  setFieldValue("plan-steps", formatLines(item.spec?.plan?.steps));
  setFieldValue("plan-rationale", item.spec?.plan?.rationale ?? "");
  setFieldValue("acceptance", formatLines(item.spec?.acceptance_criteria));
  setFieldValue("inputs", formatLines(item.spec?.inputs));
  setFieldValue("deliverables", formatLines(item.spec?.deliverables));
  setFieldValue("scope", formatLines(item.spec?.scope));
  setFieldValue("scope-paths", formatLines(item.spec?.scope_paths));
  setFieldValue("risks", formatLines(item.spec?.risks));
  setFieldValue("runbook", formatLines(item.spec?.runbook));
  setFieldValue("effort", item.details?.effort ?? "");
  setFieldValue("notes", item.notes ?? "");
  setFieldValue("deps", formatLines(item.deps));
  setFieldValue("evidence", formatLines(item.evidence));
  setFieldValue(
    "delta-inputs",
    formatLines(item.details?.contract_reflection?.delta_scan?.inputs),
  );
  setFieldValue(
    "delta-findings",
    formatLines(item.details?.contract_reflection?.delta_scan?.findings),
  );
  setFieldValue(
    "delta-evidence",
    formatLines(item.details?.contract_reflection?.delta_scan?.evidence),
  );
  setFieldValue(
    "system-inputs",
    formatLines(item.details?.contract_reflection?.system_scan?.inputs),
  );
  setFieldValue(
    "system-findings",
    formatLines(item.details?.contract_reflection?.system_scan?.findings),
  );
  setFieldValue(
    "system-evidence",
    formatLines(item.details?.contract_reflection?.system_scan?.evidence),
  );

  const tagEditor = main.querySelector("[data-field='tags']");
  if (tagEditor) {
    const items = collectTags(state.queueItems).map((tag) => ({
      id: tag,
      label: tag,
      value: tag,
    }));
    tagEditor.items = items;
    tagEditor.addEventListener("combobox-select", (event) => {
      const value = event.detail?.value ?? event.detail?.item?.value;
      if (!value) return;
      const tags = uniqueSorted([...(item.tags ?? []), value.toLowerCase()]);
      item.tags = tags;
      render();
    });
  }

  const tagList = main.querySelector("[data-tag-editor]");
  if (tagList) {
    tagList.innerHTML = (item.tags ?? [])
      .map((tag) => renderTagChip(tag, "detail"))
      .join("");
    tagList
      .querySelectorAll('[data-action="chip-remove"]')
      .forEach((button) => {
        button.addEventListener("click", () => {
          const chip = button.closest("[data-role='detail']");
          const badge = chip?.querySelector("uik-badge");
          const tag = badge?.textContent?.trim();
          if (!tag) return;
          item.tags = (item.tags ?? []).filter((entry) => entry !== tag);
          render();
        });
      });
  }

  const contractRefs = main.querySelector("[data-field='contract-refs']");
  if (contractRefs) {
    contractRefs.items = buildContractRefItems();
    contractRefs.addEventListener("combobox-select", (event) => {
      const entry = event.detail?.item;
      if (!entry) return;
      addContractRef(entry);
    });
  }

  const contractList = main.querySelector("[data-contract-ref-list]");
  if (contractList) {
    contractList
      .querySelectorAll('[data-action="chip-remove"]')
      .forEach((button) => {
        button.addEventListener("click", () => {
          const chip = button.closest("[data-role='contract']");
          if (!chip) return;
          const index = Number(chip.getAttribute("data-index"));
          if (Number.isFinite(index)) {
            state.contractRefs = state.contractRefs.filter(
              (ref) => ref.index !== index,
            );
            syncContractRefsToItem(item);
            loadContractSections().then(render);
          }
        });
      });
  }

  main
    .querySelectorAll('[data-action^="queue-"], [data-action="reflect"]')
    .forEach((button) => {
      const action = button.getAttribute("data-action");
      button.addEventListener("click", () => {
        handleQueueDetailAction(action, item);
      });
    });
}

function wireRunsView() {
  const kindFilter = main.querySelector('[data-filter="runs-kind"]');
  if (kindFilter) {
    kindFilter.value = state.filters.runsKind ?? "all";
    kindFilter.addEventListener("change", () => {
      state.filters.runsKind = kindFilter.value;
      render();
    });
  }
  const refresh = main.querySelector('[data-action="runs-refresh"]');
  if (refresh) {
    refresh.addEventListener("click", async () => {
      await loadRuns({ force: true });
      render();
    });
  }
}

function wireBlackboardView() {
  const refresh = main.querySelector('[data-action="bb-refresh"]');
  if (refresh) {
    refresh.addEventListener("click", async () => {
      await loadBlackboard({ force: true });
      render();
    });
  }
}

function wireTargetsView() {
  const refresh = main.querySelector('[data-action="targets-refresh"]');
  if (refresh) {
    refresh.addEventListener("click", async () => {
      await loadTargets({ force: true });
      render();
    });
  }
}

function wireSettingsView() {
  const refresh = main.querySelector('[data-action="settings-refresh"]');
  if (refresh) {
    refresh.addEventListener("click", async () => {
      await loadSettings({ force: true });
      render();
    });
  }
}

function setFieldValue(field, value) {
  const element = main.querySelector(`[data-field='${field}']`);
  if (!element) return;
  element.value = value ?? "";
}

function getDetailItem() {
  if (!state.detailId) return null;
  const draft = state.queueItems.find((item) => item.id === state.detailId);
  return draft ?? null;
}

function collectTags(items) {
  const tags = items.flatMap((item) => item.tags ?? []);
  return uniqueSorted(tags);
}

function collectTargetSelectors(items) {
  return uniqueSorted(
    items.map(
      (item) => item.target?.selector ?? item.target?.kind ?? "unbounded",
    ),
  );
}

function filterQueueItems(viewStatus) {
  const items = state.queueItems;
  const statusFilter = viewStatus === "all" ? state.filters.status : viewStatus;
  const priorityFilter = state.filters.priority;
  const targetFilter = state.filters.target;
  const tagFilter = state.filters.tags;

  let filtered = items.filter((item) => {
    if (statusFilter !== "all" && item.status !== statusFilter) return false;
    if (
      priorityFilter !== "all" &&
      String(item.priority) !== String(priorityFilter)
    ) {
      return false;
    }
    const selector = item.target?.selector ?? item.target?.kind ?? "unbounded";
    if (targetFilter !== "all" && selector !== targetFilter) {
      return false;
    }
    if (tagFilter.length) {
      const tags = item.tags ?? [];
      return tagFilter.every((tag) => tags.includes(tag));
    }
    return true;
  });

  filtered = sortQueueItems(filtered);
  return filtered;
}

function sortQueueItems(items) {
  const mode = state.sort.mode;
  const direction = state.sort.direction === "desc" ? -1 : 1;
  const sorted = [...items];

  if (mode === "deterministic") {
    sorted.sort((a, b) => {
      const targetDiff =
        targetSpecificity(a.target) - targetSpecificity(b.target);
      if (targetDiff !== 0) return targetDiff;
      const statusDiff = statusRank(a.status) - statusRank(b.status);
      if (statusDiff !== 0) return statusDiff;
      const priorityDiff = priorityRank(a.priority) - priorityRank(b.priority);
      if (priorityDiff !== 0) return priorityDiff;
      const createdDiff = String(a.created_at).localeCompare(
        String(b.created_at),
      );
      if (createdDiff !== 0) return createdDiff;
      return String(a.id).localeCompare(String(b.id));
    });
    return sorted;
  }

  if (mode === "created") {
    sorted.sort(
      (a, b) =>
        String(a.created_at).localeCompare(String(b.created_at)) * direction,
    );
    return sorted;
  }

  if (mode === "priority") {
    sorted.sort(
      (a, b) =>
        (priorityRank(a.priority) - priorityRank(b.priority)) * direction,
    );
  }

  return sorted;
}

function filterRuns() {
  const kind = state.filters.runsKind ?? "all";
  if (kind === "all") return state.runs;
  return state.runs.filter((entry) => entry.kind === kind);
}

function canTransition(status, nextStatus) {
  const allowed = STATUS_TRANSITIONS.get(status) ?? new Set();
  return allowed.has(nextStatus);
}

function badgeVariantForStatus(status) {
  if (status === "blocked" || status === "dropped") return "danger";
  if (status === "done") return "secondary";
  if (status === "active") return "secondary";
  return "outline";
}

function isWriteDisabled() {
  const protocolOk = state.status?.protocol?.ok ?? false;
  const locked = state.status?.lock?.isLocked ?? false;
  return !protocolOk || locked || !state.status?.target;
}

async function loadStatus() {
  try {
    state.viewErrors.header = null;
    const data = await requestJson(buildApiUrl("/api/status"));
    state.status = data;
    if (!state.targetSelection) {
      const available = data.targets?.available ?? [];
      const availableIds = new Set(available.map((entry) => entry.id));
      if (data.target?.id && availableIds.has(data.target.id)) {
        state.targetSelection = data.target.id;
      } else if (data.target?.root) {
        state.targetSelection = data.target.root;
      } else {
        state.targetSelection = null;
      }
    }
    if (data.targets?.requireSelection) {
      openTargetDialog(data.targets.available ?? []);
    }
  } catch (error) {
    state.viewErrors.header = error;
  }
}

async function loadViewData({ force }) {
  switch (state.view) {
    case "queue":
    case "active":
    case "blocked":
    case "done":
      await loadQueue({ force });
      if (state.detailId) {
        await loadContractIndex();
        await loadContractSections();
      }
      if (state.view === "active") {
        await loadActiveBundle({ force });
      }
      break;
    case "runs":
      await loadRuns({ force });
      break;
    case "blackboard":
      await loadBlackboard({ force });
      break;
    case "targets":
      await loadTargets({ force });
      break;
    case "settings":
      await loadSettings({ force });
      break;
    default:
      break;
  }
}

async function loadQueue({ force }) {
  if (state.loading.queue) return;
  if (!force && state.queueItems.length) return;
  state.loading.queue = true;
  try {
    state.viewErrors.queue = null;
    const data = await requestJson(buildApiUrl("/api/queue"));
    state.queueItems = data.items ?? [];
  } catch (error) {
    state.viewErrors.queue = error;
  } finally {
    state.loading.queue = false;
  }
}

async function loadRuns({ force }) {
  if (state.loading.runs) return;
  if (!force && state.runs.length) return;
  state.loading.runs = true;
  try {
    state.viewErrors.runs = null;
    const data = await requestJson(buildApiUrl("/api/runs"));
    state.runs = data.items ?? [];
  } catch (error) {
    state.viewErrors.runs = error;
  } finally {
    state.loading.runs = false;
  }
}

async function loadBlackboard({ force }) {
  if (state.loading.blackboard) return;
  if (!force && state.blackboard) return;
  state.loading.blackboard = true;
  try {
    state.viewErrors.blackboard = null;
    const data = await requestJson(buildApiUrl("/api/blackboard"));
    state.blackboard = data.state ?? null;
  } catch (error) {
    state.viewErrors.blackboard = error;
  } finally {
    state.loading.blackboard = false;
  }
}

async function loadTargets({ force }) {
  if (state.loading.targets) return;
  if (!force && state.targets) return;
  state.loading.targets = true;
  try {
    state.viewErrors.targets = null;
    const data = await requestJson(buildApiUrl("/api/targets"));
    state.targets = data;
  } catch (error) {
    state.viewErrors.targets = error;
  } finally {
    state.loading.targets = false;
  }
}

async function loadSettings({ force }) {
  if (state.loading.settings) return;
  if (!force && state.config) return;
  state.loading.settings = true;
  try {
    state.viewErrors.settings = null;
    const data = await requestJson(buildApiUrl("/api/config"));
    state.config = data;
  } catch (error) {
    state.viewErrors.settings = error;
  } finally {
    state.loading.settings = false;
  }
}

async function loadActiveBundle({ force }) {
  if (state.loading.active) return;
  if (!force && state.activeBundle) return;
  state.loading.active = true;
  try {
    const data = await requestJson(buildApiUrl("/api/active"));
    state.activeBundle = data;
  } catch (error) {
    state.viewErrors.queue = error;
  } finally {
    state.loading.active = false;
  }
}

async function loadContractIndex() {
  if (state.contractIndex) return;
  try {
    const data = await requestJson(buildApiUrl("/api/contracts/index"));
    state.contractIndex = data;
  } catch (error) {
    state.viewErrors.detail = error;
  }
}

async function loadContractSections() {
  const item = getDetailItem();
  if (!item) return;
  const refs = item.spec?.contract_refs ?? [];
  if (!refs.length) {
    state.contractSections = [];
    return;
  }
  try {
    const data = await requestJson(buildApiUrl("/api/contracts/extract"), {
      method: "POST",
      body: JSON.stringify({ refs }),
    });
    state.contractSections = data.sections ?? [];
  } catch (error) {
    state.viewErrors.detail = error;
  }
}

function buildContractRefItems() {
  const index = state.contractIndex?.docs ?? [];
  const items = [];
  index.forEach((docEntry) => {
    docEntry.entries.forEach((entry) => {
      const baseLabel = entry.sectionNumber
        ? `${entry.sectionNumber} ${entry.heading}`
        : entry.heading;
      const label = entry.path ? `${baseLabel} - ${entry.path}` : baseLabel;
      items.push({
        id: `${docEntry.doc}::${entry.id}`,
        label,
        value: entry.sectionNumber ?? entry.heading,
        doc: docEntry.doc,
        path: entry.path,
      });
    });
  });
  return items;
}

function addContractRef(entry) {
  const item = getDetailItem();
  if (!item) return;
  const root = state.status?.target?.root ?? "";
  const relativeDoc = entry.doc.startsWith(root)
    ? entry.doc.slice(root.length + 1)
    : entry.doc;
  const next = {
    doc: relativeDoc,
    section: entry.value,
    label: entry.label ?? `${entry.value} ${entry.path}`,
    kind: "contract",
    index: Date.now(),
  };
  const list = state.contractRefs.filter((ref) => ref.kind === "contract");
  state.contractRefs = [...list, next];
  syncContractRefsToItem(item);
  loadContractSections().then(render);
}

function syncContractRefsToItem(item) {
  const refs = state.contractRefs
    .filter((ref) => ref.kind === "contract")
    .map((ref) =>
      ref.doc ? { doc: ref.doc, section: ref.section } : ref.section,
    );
  item.spec = item.spec ?? {};
  item.spec.contract_refs = refs;
}

function handleQueueAction(action, id) {
  if (action === "queue-open") {
    state.detailId = id;
    state.detailTab = "summary";
    window.location.hash = `#${state.view}/${id}`;
    render();
    return;
  }
  if (action === "queue-new") {
    createQueueItem();
    return;
  }
  if (action === "queue-refresh") {
    loadQueue({ force: true }).then(render);
    return;
  }
  if (action === "queue-start") {
    transitionQueue("start", id);
    return;
  }
  if (action === "queue-block") {
    openBlockDialog(id);
    return;
  }
  if (action === "queue-done") {
    openDoneDialog(id);
  }
}

function handleQueueDetailAction(action, item) {
  if (action === "queue-back") {
    state.detailId = null;
    window.location.hash = `#${state.view}`;
    render();
    return;
  }
  if (action === "queue-save") {
    saveQueueItem(item);
    return;
  }
  if (action === "queue-start") {
    transitionQueue("start", item.id);
    return;
  }
  if (action === "queue-block") {
    openBlockDialog(item.id);
    return;
  }
  if (action === "queue-done") {
    openDoneDialog(item.id);
    return;
  }
  if (action === "reflect") {
    openReflectDialog(item.id);
  }
}

async function createQueueItem() {
  try {
    const data = await requestJson(buildApiUrl("/api/queue/template"));
    const item = data.item;
    state.queueItems = [...state.queueItems, item];
    state.detailId = item.id;
    state.detailTab = "summary";
    state.detailErrors = [];
    window.location.hash = `#${state.view}/${item.id}`;
    render();
  } catch (error) {
    state.viewErrors.queue = error;
    render();
  }
}

async function saveQueueItem(item) {
  if (!item) return;
  if (isWriteDisabled()) return;
  const updated = buildItemFromForm(item);
  try {
    const data = await requestJson(buildApiUrl("/api/queue/save"), {
      method: "POST",
      body: JSON.stringify({ item: updated }),
    });
    state.detailErrors = [];
    state.viewErrors.detail = null;
    state.queueItems = data.items ?? state.queueItems;
    await loadStatus();
    render();
  } catch (error) {
    state.detailErrors = error.details?.errors ?? [];
    state.viewErrors.detail = error;
    render();
  }
}

function buildItemFromForm(item) {
  const updated = { ...item };
  updated.title = getFieldValue("title");
  updated.type = getFieldValue("type");
  updated.priority = getFieldValue("priority");
  updated.notes = getFieldValue("notes");
  updated.tags = uniqueSorted(
    (item.tags ?? []).map((tag) => tag.toLowerCase()),
  );

  const selector = getFieldValue("target-selector");
  const value = getFieldValue("target-value");
  updated.target =
    selector === "unbounded" ? { selector } : { selector, value };

  updated.deps = parseLines(getFieldValue("deps"));
  updated.evidence = parseLines(getFieldValue("evidence"));

  const scopePaths = parseLines(getFieldValue("scope-paths"));
  const contractRefs = state.contractRefs
    .filter((ref) => ref.kind === "contract")
    .map((ref) =>
      ref.doc ? { doc: ref.doc, section: ref.section } : ref.section,
    );

  updated.spec = {
    problem: getFieldValue("problem"),
    outcome: getFieldValue("outcome"),
    plan: {
      steps: parseLines(getFieldValue("plan-steps")),
      ...(getFieldValue("plan-rationale")
        ? { rationale: getFieldValue("plan-rationale") }
        : {}),
    },
    acceptance_criteria: parseLines(getFieldValue("acceptance")),
    inputs: parseLines(getFieldValue("inputs")),
    deliverables: parseLines(getFieldValue("deliverables")),
    scope: parseLines(getFieldValue("scope")),
    risks: parseLines(getFieldValue("risks")),
    contract_refs: contractRefs,
    runbook: parseLines(getFieldValue("runbook")),
    ...(scopePaths.length ? { scope_paths: scopePaths } : {}),
  };

  const details = { ...(updated.details ?? {}) };
  details.rationale = getFieldValue("rationale");
  details.effort = getFieldValue("effort") || undefined;

  details.contract_reflection = details.contract_reflection ?? {};
  details.contract_reflection.delta_scan = buildScanFromFields("delta");
  details.contract_reflection.system_scan = buildScanFromFields("system");

  updated.details = details;
  return updated;
}

function buildScanFromFields(prefix) {
  return {
    inputs: parseLines(getFieldValue(`${prefix}-inputs`)),
    findings: parseLines(getFieldValue(`${prefix}-findings`)),
    evidence: parseLines(getFieldValue(`${prefix}-evidence`)),
  };
}

function getFieldValue(field) {
  const element = main.querySelector(`[data-field='${field}']`);
  return element?.value ?? "";
}

async function transitionQueue(action, id, options = {}) {
  if (!id || isWriteDisabled()) return;
  try {
    await requestJson(buildApiUrl("/api/queue/transition"), {
      method: "POST",
      body: JSON.stringify({ action, id, ...options }),
    });
    await loadQueue({ force: true });
    await loadStatus();
    render();
  } catch (error) {
    state.viewErrors.queue = error;
    render();
  }
}

function openTargetDialog(targets) {
  if (!targets.length) return;
  const dialog = document.createElement("uik-dialog");
  dialog.innerHTML = `
    <span slot="title">Select a target</span>
    <span slot="description">Choose the target to enable write actions.</span>
    <div class="dashboard-dialog-body">
      <uik-select data-dialog-target>
        ${targets
          .map(
            (target) =>
              `<option value="${escapeHtml(target.id)}">${escapeHtml(
                target.id,
              )}</option>`,
          )
          .join("")}
      </uik-select>
    </div>
    <div slot="actions" class="dashboard-actions-row">
      <uik-button data-dialog-confirm variant="solid">Continue</uik-button>
    </div>
  `;
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  document.body.appendChild(dialog);
  dialog.showModal();
  const confirm = dialog.querySelector("[data-dialog-confirm]");
  const select = dialog.querySelector("[data-dialog-target]");
  if (confirm && select) {
    confirm.addEventListener("click", async () => {
      state.targetSelection = select.value;
      resetTargetData();
      dialog.close();
      dialog.remove();
      await loadStatus();
      await loadViewData({ force: true });
      render();
    });
  }
}

function openBlockDialog(id) {
  openDialog({
    title: "Block item",
    body: `
      <uik-textarea data-dialog-reason>
        <span slot="label">Reason (optional)</span>
      </uik-textarea>
    `,
    confirmLabel: "Block",
    onConfirm: (dialog) => {
      const reason = dialog.querySelector("[data-dialog-reason]")?.value ?? "";
      transitionQueue("block", id, { reason });
    },
  });
}

function openDoneDialog(id) {
  const item = state.queueItems.find((entry) => entry.id === id) ?? null;
  const tags = item?.tags ?? [];
  const defaultMode =
    tags.includes("macro-scope") || tags.includes("contract") ? "full" : "fast";
  openDialog({
    title: "Complete item",
    body: `
      <uik-select data-dialog-mode>
        <span slot="label">Gate mode</span>
        <option value="fast" ${defaultMode === "fast" ? "selected" : ""}>fast</option>
        <option value="full" ${defaultMode === "full" ? "selected" : ""}>full</option>
      </uik-select>
      <span class="dashboard-field-help">Runs gates before marking done.</span>
    `,
    confirmLabel: "Run gates",
    onConfirm: (dialog) => {
      const mode = dialog.querySelector("[data-dialog-mode]")?.value ?? "fast";
      transitionQueue("done", id, { mode });
    },
  });
}

function openPackDialog() {
  openDialog({
    title: "Generate pack",
    body: `
      <uik-input data-dialog-task>
        <span slot="label">Task</span>
      </uik-input>
      <uik-input data-dialog-focus>
        <span slot="label">Focus (optional)</span>
      </uik-input>
      <uik-input data-dialog-budget>
        <span slot="label">Budget (tokens)</span>
      </uik-input>
      <uik-select data-dialog-format>
        <span slot="label">Format</span>
        <option value="md">md</option>
        <option value="json">json</option>
      </uik-select>
      <uik-input data-dialog-queue>
        <span slot="label">Queue id (optional)</span>
      </uik-input>
    `,
    confirmLabel: "Generate",
    onConfirm: async (dialog) => {
      const task = dialog.querySelector("[data-dialog-task]")?.value ?? "";
      const focus = dialog.querySelector("[data-dialog-focus]")?.value ?? "";
      const budget = dialog.querySelector("[data-dialog-budget]")?.value ?? "";
      const format =
        dialog.querySelector("[data-dialog-format]")?.value ?? "md";
      const queue = dialog.querySelector("[data-dialog-queue]")?.value ?? "";
      if (!task) return;
      try {
        const data = await requestJson(buildApiUrl("/api/pack"), {
          method: "POST",
          body: JSON.stringify({ task, focus, budget, format, queue }),
        });
        openDialog({
          title: "Pack generated",
          body: `
            <div class="dashboard-field-help">${escapeHtml(data.path)}</div>
            <pre class="dashboard-code-block dashboard-json-output">${escapeHtml(
              data.output,
            )}</pre>
          `,
          confirmLabel: "Close",
          onConfirm: () => {},
          hideCancel: true,
        });
      } catch (error) {
        state.viewErrors.header = error;
        render();
      }
    },
  });
}

function openGateDialog() {
  openDialog({
    title: "Run gates",
    body: `
      <uik-select data-dialog-mode>
        <span slot="label">Mode</span>
        <option value="fast">fast</option>
        <option value="full">full</option>
      </uik-select>
    `,
    confirmLabel: "Run",
    onConfirm: async (dialog) => {
      const mode = dialog.querySelector("[data-dialog-mode]")?.value ?? "fast";
      try {
        await requestJson(buildApiUrl("/api/gate/run"), {
          method: "POST",
          body: JSON.stringify({ mode }),
        });
        await loadStatus();
        await loadRuns({ force: true });
        render();
      } catch (error) {
        state.viewErrors.header = error;
        render();
      }
    },
  });
}

function openReflectDialog(id) {
  openDialog({
    title: "Reflect record",
    body: `
      <uik-textarea data-dialog-json>
        <span slot="label">Reflection JSON</span>
      </uik-textarea>
    `,
    confirmLabel: "Record",
    onConfirm: async (dialog) => {
      const input = dialog.querySelector("[data-dialog-json]")?.value ?? "";
      if (!input) return;
      try {
        await requestJson(buildApiUrl("/api/reflect/record"), {
          method: "POST",
          body: JSON.stringify({ id, input }),
        });
        await loadQueue({ force: true });
        await loadStatus();
        render();
      } catch (error) {
        state.viewErrors.detail = error;
        render();
      }
    },
  });
}

function openDialog({ title, body, confirmLabel, onConfirm, hideCancel }) {
  const dialog = document.createElement("uik-dialog");
  dialog.innerHTML = `
    <span slot="title">${escapeHtml(title)}</span>
    <div class="dashboard-dialog-body">${body}</div>
    <div slot="actions" class="dashboard-actions-row">
      ${
        hideCancel
          ? ""
          : `<uik-button data-dialog-cancel variant="ghost">Cancel</uik-button>`
      }
      <uik-button data-dialog-confirm variant="solid">${escapeHtml(
        confirmLabel,
      )}</uik-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.showModal();

  const confirm = dialog.querySelector("[data-dialog-confirm]");
  const cancel = dialog.querySelector("[data-dialog-cancel]");

  const cleanup = () => {
    dialog.close();
    dialog.remove();
  };

  if (confirm) {
    confirm.addEventListener("click", async () => {
      await onConfirm(dialog);
      cleanup();
    });
  }

  if (cancel) {
    cancel.addEventListener("click", cleanup);
  }
}
