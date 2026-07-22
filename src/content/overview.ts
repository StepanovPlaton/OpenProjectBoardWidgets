import { sendMessage } from "../shared/messaging";
import type {
  BackgroundResponse,
  GithubPullRequestOverviewItem,
  RelationOverviewItem,
  Settings,
  WorkPackageOverviewExtras,
} from "../shared/types";

const OVERVIEW_HOST_SELECTOR =
  "opce-wp-split-view[data-active-tab*='overview'] .work-package--single-view";
const OVERVIEW_MOUNT_ATTR = "data-op-ext-overview-mounted";
const OVERVIEW_FETCH_ATTR = "data-op-ext-overview-fetch";
const OVERVIEW_SECTION_CLASS = "op-board-ext-overview-section";
const OVERVIEW_SECTION_RELATIONS = "op-board-ext-overview-relations";
const OVERVIEW_SECTION_GITHUB = "op-board-ext-overview-github";
const OVERVIEW_STATUS_CLASS = "op-board-ext-overview-status";

const RELATION_LABELS: Record<string, string> = {
  relates: "Связан с",
  follows: "Предшественник",
  precedes: "Наследник",
  parent: "Родитель",
  child: "Дочерний",
  duplicates: "Дублирует",
  duplicated: "Дублируется",
  blocks: "Блокирует",
  blocked: "Заблокирован",
  includes: "Включает",
  partof: "Является частью",
  requires: "Требует выполнения",
  required: "Необходим для",
};

const PR_STATE_LABELS: Record<string, string> = {
  open: "Открыт",
  closed: "Закрыт",
  merged: "Смержен",
  draft: "Draft",
};

let syncTimer: number | null = null;
let overviewObserverStarted = false;
let overviewSettingsGetter: () => Settings | null = () => null;
const overviewCache = new Map<number, Promise<WorkPackageOverviewExtras>>();

function getCurrentWorkPackageId(): number | null {
  const splitView = document.querySelector<HTMLElement>("opce-wp-split-view[data-work-package-id]");
  const rawId = splitView?.getAttribute("data-work-package-id")?.replace(/&quot;/g, "").trim();
  if (rawId) {
    const domId = Number(rawId);
    if (Number.isFinite(domId) && domId > 0) return domId;
  }

  const match = location.pathname.match(/(?:details|work_packages)\/(\d+)(?:\/|$)/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function isOverviewActive(): boolean {
  return document.querySelector(OVERVIEW_HOST_SELECTOR) != null;
}

function scheduleOverviewSync(): void {
  if (syncTimer != null) {
    window.clearTimeout(syncTimer);
  }

  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    void syncOverviewEnhancements(overviewSettingsGetter);
  }, 100);
}

function getOverviewHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>(OVERVIEW_HOST_SELECTOR);
}

function ensureOverviewMount(host: HTMLElement): HTMLElement {
  let mount = host.querySelector<HTMLElement>(`:scope > .${OVERVIEW_SECTION_CLASS}-mount`);
  if (!mount) {
    mount = document.createElement("section");
    mount.className = `${OVERVIEW_SECTION_CLASS}-mount`;
    host.appendChild(mount);
  }
  return mount;
}

function cleanupOverviewExtras(host?: HTMLElement | null): void {
  const target = host ?? getOverviewHost();
  if (!target) return;

  target.removeAttribute(OVERVIEW_MOUNT_ATTR);
  target.removeAttribute(OVERVIEW_FETCH_ATTR);
  target.querySelector(`:scope > .${OVERVIEW_SECTION_CLASS}-mount`)?.remove();
}

function cleanupOverviewEnhancements(host?: HTMLElement | null): void {
  const target = host ?? getOverviewHost();
  if (!target) return;

  target.classList.remove("op-board-ext-overview-compact");
  cleanupOverviewExtras(target);
}

function applyOverviewRedesign(host: HTMLElement, enabled: boolean): void {
  host.classList.toggle("op-board-ext-overview-compact", enabled);
}

function renderStatus(host: HTMLElement, message: string, tone: "loading" | "error"): void {
  const mount = ensureOverviewMount(host);
  const status = document.createElement("section");
  status.className = `${OVERVIEW_STATUS_CLASS} ${OVERVIEW_STATUS_CLASS}_${tone}`;
  status.textContent = message;
  mount.replaceChildren(status);
}

function relationLabel(type: string): string {
  return RELATION_LABELS[type] ?? type;
}

function prStateLabel(state: string): string {
  return PR_STATE_LABELS[state] ?? state;
}

function formatDateTime(value: string | null): string {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function renderRelationItem(item: RelationOverviewItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "op-board-ext-overview-item op-board-ext-overview-item_relation";

  const top = document.createElement("div");
  top.className = "op-board-ext-overview-item-top";

  const type = document.createElement("span");
  type.className = "op-board-ext-overview-pill op-board-ext-overview-pill_relation";
  type.textContent = relationLabel(item.type);

  const status = document.createElement("span");
  status.className = item.otherIsClosed
    ? "op-board-ext-overview-pill op-board-ext-overview-pill_success"
    : "op-board-ext-overview-pill op-board-ext-overview-pill_muted";
  status.textContent = item.otherStatusName || "Без статуса";

  top.append(type, status);

  const link = document.createElement("a");
  link.className = "op-board-ext-overview-link";
  link.href = `/work_packages/${item.otherId}`;
  link.textContent = `#${item.otherId} ${item.otherSubject}`;

  row.append(top, link);
  return row;
}

function summarizeChecks(checks: GithubPullRequestOverviewItem["checks"]): string {
  if (checks.length === 0) return "Нет проверок";
  const successful = checks.filter((check) => check.state === "success").length;
  return `${successful}/${checks.length} успешны`;
}

function renderCheckList(checks: GithubPullRequestOverviewItem["checks"]): HTMLElement | null {
  if (checks.length === 0) return null;

  const list = document.createElement("div");
  list.className = "op-board-ext-overview-checks";

  for (const check of checks) {
    const item = document.createElement("a");
    item.className =
      check.state === "success"
        ? "op-board-ext-overview-pill op-board-ext-overview-pill_success"
        : "op-board-ext-overview-pill op-board-ext-overview-pill_danger";
    item.textContent = check.name;
    if (check.detailsUrl) {
      item.href = check.detailsUrl;
      item.target = "_blank";
      item.rel = "noopener noreferrer";
    } else {
      item.setAttribute("role", "status");
      item.removeAttribute("href");
    }
    list.appendChild(item);
  }

  return list;
}

function renderPullRequestItem(item: GithubPullRequestOverviewItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "op-board-ext-overview-item op-board-ext-overview-item_pr";

  const top = document.createElement("div");
  top.className = "op-board-ext-overview-item-top";

  const state = document.createElement("span");
  state.className =
    item.state === "open"
      ? "op-board-ext-overview-pill op-board-ext-overview-pill_success"
      : "op-board-ext-overview-pill op-board-ext-overview-pill_muted";
  state.textContent = prStateLabel(item.state);

  const checks = document.createElement("span");
  checks.className = "op-board-ext-overview-pill op-board-ext-overview-pill_muted";
  checks.textContent = summarizeChecks(item.checks);

  top.append(state, checks);

  const link = document.createElement("a");
  link.className = "op-board-ext-overview-link";
  link.href = item.url || "#";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = item.repositoryLabel && item.number != null
    ? `${item.repositoryLabel}#${item.number}`
    : item.title;

  const title = document.createElement("div");
  title.className = "op-board-ext-overview-subtext";
  title.textContent = item.title;

  const meta = document.createElement("div");
  meta.className = "op-board-ext-overview-subtext";
  const author = item.authorName ? `Автор: ${item.authorName}` : "";
  const updated = formatDateTime(item.updatedAt);
  meta.textContent = [author, updated ? `Обновлено: ${updated}` : ""].filter(Boolean).join(" • ");

  row.append(top, link, title);
  if (meta.textContent) row.appendChild(meta);

  const checkList = renderCheckList(item.checks);
  if (checkList) row.appendChild(checkList);

  return row;
}

function createSection(
  titleText: string,
  emptyText: string,
  className: string,
  items: HTMLElement[],
): HTMLElement {
  const section = document.createElement("section");
  section.className = `${OVERVIEW_SECTION_CLASS} ${className}`;

  const title = document.createElement("h3");
  title.className = "op-board-ext-overview-title";
  title.textContent = titleText;

  const body = document.createElement("div");
  body.className = "op-board-ext-overview-list";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "op-board-ext-overview-empty";
    empty.textContent = emptyText;
    body.appendChild(empty);
  } else {
    items.forEach((item) => body.appendChild(item));
  }

  section.append(title, body);
  return section;
}

function renderOverviewExtras(host: HTMLElement, extras: WorkPackageOverviewExtras): void {
  host.setAttribute(OVERVIEW_MOUNT_ATTR, "1");

  const mount = ensureOverviewMount(host);
  mount.replaceChildren(
    createSection(
      "Связи",
      "У этого пакета работ пока нет связей.",
      OVERVIEW_SECTION_RELATIONS,
      extras.relations.map(renderRelationItem),
    ),
    createSection(
      "GitHub",
      "К этой задаче пока не привязаны pull request.",
      OVERVIEW_SECTION_GITHUB,
      extras.pullRequests.map(renderPullRequestItem),
    ),
  );
}

async function getOverviewExtras(workPackageId: number): Promise<WorkPackageOverviewExtras> {
  const cached = overviewCache.get(workPackageId);
  if (cached) return cached;

  const request = sendMessage<BackgroundResponse>({
    type: "GET_WORK_PACKAGE_OVERVIEW_EXTRAS",
    id: workPackageId,
  }).then((response) => {
    if (!response.ok || !("overviewExtras" in response)) {
      throw new Error(response.ok ? "Unexpected background response" : response.error);
    }
    return response.overviewExtras;
  });

  overviewCache.set(workPackageId, request);
  return request;
}

async function syncOverviewEnhancements(getSettings: () => Settings | null): Promise<void> {
  if (!isOverviewActive()) return;

  const workPackageId = getCurrentWorkPackageId();
  const host = getOverviewHost();
  if (!workPackageId || !host) return;

  const settings = getSettings();
  const redesignEnabled = Boolean(settings?.overviewRedesign);
  const extendedEnabled = Boolean(settings?.overviewExtended);

  if (!redesignEnabled && !extendedEnabled) {
    cleanupOverviewEnhancements(host);
    return;
  }

  applyOverviewRedesign(host, redesignEnabled);

  if (!extendedEnabled) {
    cleanupOverviewExtras(host);
    return;
  }

  if (host.getAttribute(OVERVIEW_FETCH_ATTR) === String(workPackageId)) return;
  host.setAttribute(OVERVIEW_FETCH_ATTR, String(workPackageId));
  renderStatus(host, `Загружаю данные для задачи #${workPackageId}...`, "loading");

  try {
    const extras = await getOverviewExtras(workPackageId);
    const activeHost = getOverviewHost();
    if (!activeHost) return;

    const latest = getSettings();
    applyOverviewRedesign(activeHost, Boolean(latest?.overviewRedesign));
    if (!latest?.overviewExtended) {
      cleanupOverviewExtras(activeHost);
      return;
    }

    renderOverviewExtras(activeHost, extras);
  } catch (error) {
    host.removeAttribute(OVERVIEW_FETCH_ATTR);
    const message = error instanceof Error ? error.message : String(error);
    renderStatus(host, `Не удалось загрузить блоки Связи/GitHub: ${message}`, "error");
    console.warn("[op-board-ext] overview extras failed", {
      workPackageId,
      path: location.pathname,
      message,
      error,
    });
  }
}

export function initOverviewEnhancer(getSettings: () => Settings | null): void {
  overviewSettingsGetter = getSettings;
  if (overviewObserverStarted) return;
  overviewObserverStarted = true;

  scheduleOverviewSync();

  const observer = new MutationObserver(() => {
    scheduleOverviewSync();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-active-tab"],
  });
}

export function refreshOverviewEnhancer(): void {
  scheduleOverviewSync();
}
