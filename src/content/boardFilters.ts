import { sendMessage } from "../shared/messaging";
import type { BackgroundResponse, Settings } from "../shared/types";

const LOG = "[op-board-ext]";
const TOOLBAR_ATTR = "data-op-board-ext-filters";
const SPRINT_CACHE_PREFIX = "op-board-ext-sprint:";

type QueryFilter = Record<string, { operator: string; values: string[] }>;

type QuickFilterMode = "department" | "assignee";

let settingsGetter: () => Settings | null = () => null;
let injectTimer: number | null = null;

function isBoardPage(): boolean {
  return /\/boards\/\d+/i.test(location.pathname);
}

function boardIdFromPath(): number | null {
  const match = location.pathname.match(/\/boards\/(\d+)/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function boardBasePath(): string {
  return location.pathname.replace(/\/details\/\d+\/?$/i, "").replace(/\/+$/, "");
}

function sprintCacheKey(boardId: number): string {
  return `${SPRINT_CACHE_PREFIX}${boardId}`;
}

function parseQueryProps(search: string = location.search): QueryFilter[] {
  const raw = new URLSearchParams(search).get("query_props");
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is QueryFilter => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      return Object.values(item).every((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const filter = value as { operator?: unknown; values?: unknown };
        return typeof filter.operator === "string" && Array.isArray(filter.values);
      });
    });
  } catch {
    return [];
  }
}

function getFilterValues(filters: QueryFilter[], key: string): string[] | null {
  for (const filter of filters) {
    if (!(key in filter)) continue;
    const values = filter[key]?.values;
    if (Array.isArray(values) && values.length > 0) {
      return values.map(String);
    }
  }
  return null;
}

function cacheSprintValues(boardId: number, values: string[]): void {
  try {
    sessionStorage.setItem(sprintCacheKey(boardId), JSON.stringify(values));
  } catch {
    // ignore quota / private mode
  }
}

function readCachedSprintValues(boardId: number): string[] | null {
  try {
    const raw = sessionStorage.getItem(sprintCacheKey(boardId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.map(String);
  } catch {
    return null;
  }
}

function readSprintFromDom(): string[] | null {
  const selectors = [
    '[data-filter-name="sprint"] [data-qa-selector="filter-value"]',
    '[data-filter-name="sprint"] .ng-value',
    '[data-qa-filter-name="sprint"] [data-qa-selector="filter-value"]',
    ".advanced-filters--filter[data-filter-name='sprint'] input[type='hidden']",
  ];

  for (const selector of selectors) {
    const nodes = document.querySelectorAll(selector);
    const values: string[] = [];
    nodes.forEach((node) => {
      if (node instanceof HTMLInputElement && node.value.trim()) {
        values.push(node.value.trim());
        return;
      }
      const id =
        node.getAttribute("data-id") ||
        node.getAttribute("data-value") ||
        node.getAttribute("data-ng-value") ||
        "";
      if (id.trim()) values.push(id.trim());
    });
    if (values.length > 0) return [...new Set(values)];
  }
  return null;
}

async function resolveSprintValues(): Promise<string[] | null> {
  const boardId = boardIdFromPath();
  if (!boardId) return null;

  const fromUrl = getFilterValues(parseQueryProps(), "sprint");
  if (fromUrl?.length) {
    cacheSprintValues(boardId, fromUrl);
    return fromUrl;
  }

  const fromDom = readSprintFromDom();
  if (fromDom?.length) {
    cacheSprintValues(boardId, fromDom);
    return fromDom;
  }

  const cached = readCachedSprintValues(boardId);
  if (cached?.length) return cached;

  try {
    const response = await sendMessage<BackgroundResponse>({
      type: "RESOLVE_BOARD_SPRINT",
      boardId,
    });
    if (response.ok && "sprintValues" in response && response.sprintValues.length > 0) {
      cacheSprintValues(boardId, response.sprintValues);
      return response.sprintValues;
    }
  } catch (error) {
    console.warn(`${LOG} resolve sprint failed`, error);
  }

  return null;
}

function buildQueryProps(sprintValues: string[], mode: QuickFilterMode, settings: Settings): QueryFilter[] {
  const filters: QueryFilter[] = [
    { sprint: { operator: "=", values: sprintValues } },
  ];

  if (mode === "department") {
    const field = settings.department.field.trim() || "customField2";
    const value = settings.department.filterValue.trim();
    filters.push({ [field]: { operator: "=", values: [value] } });
  } else {
    filters.push({ assignee: { operator: "=", values: ["me"] } });
  }

  return filters;
}

function navigateWithFilters(filters: QueryFilter[]): void {
  const url = new URL(location.href);
  url.pathname = boardBasePath();
  url.searchParams.set("query_props", JSON.stringify(filters));
  url.hash = "";
  location.assign(url.toString());
}

function currentMode(settings: Settings | null): QuickFilterMode | null {
  const filters = parseQueryProps();
  if (!filters.length) return null;

  const hasAssignee = Boolean(getFilterValues(filters, "assignee")?.includes("me"));
  const deptField = settings?.department.field.trim() || "customField2";
  const deptValue = settings?.department.filterValue.trim() || "";
  const deptValues = getFilterValues(filters, deptField);
  const hasDepartment = Boolean(deptValue && deptValues?.includes(deptValue));

  if (hasAssignee && !hasDepartment) return "assignee";
  if (hasDepartment && !hasAssignee) return "department";
  return null;
}

function findFilterToolbarItem(): HTMLElement | null {
  const filterButton =
    document.querySelector<HTMLElement>("#work-packages-filter-toggle-button") ||
    document.querySelector<HTMLElement>('wp-filter-button button, [data-test-selector="wp-filter-button"]');
  if (!filterButton) return null;
  return filterButton.closest<HTMLElement>("li.toolbar-item");
}

function createToolbarItem(
  label: string,
  mode: QuickFilterMode,
  options: { disabled: boolean; active: boolean; title: string },
): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "toolbar-item hidden-for-tablet";
  li.setAttribute(TOOLBAR_ATTR, mode);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "button op-board-ext-quick-filter";
  if (options.active) button.classList.add("-active");
  button.textContent = label;
  button.title = options.title;
  button.disabled = options.disabled;
  button.setAttribute("aria-pressed", options.active ? "true" : "false");
  button.addEventListener("click", () => {
    void onQuickFilterClick(mode);
  });

  li.appendChild(button);
  return li;
}

async function onQuickFilterClick(mode: QuickFilterMode): Promise<void> {
  const settings = settingsGetter();
  if (!settings) return;

  if (mode === "department" && !settings.department.filterValue.trim()) {
    return;
  }

  const sprintValues = await resolveSprintValues();
  if (!sprintValues?.length) {
    console.warn(`${LOG} cannot apply ${mode} filter: sprint not found`);
    window.alert("Не удалось определить текущий спринт на доске.");
    return;
  }

  const filters = buildQueryProps(sprintValues, mode, settings);
  navigateWithFilters(filters);
}

function syncToolbarButtons(): void {
  if (!isBoardPage()) {
    document.querySelectorAll(`[${TOOLBAR_ATTR}]`).forEach((node) => node.remove());
    return;
  }

  const filterItem = findFilterToolbarItem();
  if (!filterItem?.parentElement) return;

  const settings = settingsGetter();
  const active = currentMode(settings);
  const deptValue = settings?.department.filterValue.trim() || "";
  const deptDisabled = !deptValue;

  const existing = filterItem.parentElement.querySelectorAll<HTMLElement>(`[${TOOLBAR_ATTR}]`);
  if (existing.length === 2) {
    const deptBtn = existing[0]?.querySelector("button");
    const mineBtn = existing[1]?.querySelector("button");
    if (deptBtn instanceof HTMLButtonElement) {
      deptBtn.disabled = deptDisabled;
      deptBtn.title = deptDisabled
        ? "Укажите ID отдела в настройках расширения"
        : "Фильтр: спринт + мой отдел";
      deptBtn.classList.toggle("-active", active === "department");
      deptBtn.setAttribute("aria-pressed", active === "department" ? "true" : "false");
    }
    if (mineBtn instanceof HTMLButtonElement) {
      mineBtn.title = "Фильтр: спринт + назначенные мне";
      mineBtn.classList.toggle("-active", active === "assignee");
      mineBtn.setAttribute("aria-pressed", active === "assignee" ? "true" : "false");
    }
    return;
  }

  existing.forEach((node) => node.remove());

  const deptItem = createToolbarItem("Мой отдел", "department", {
    disabled: deptDisabled,
    active: active === "department",
    title: deptDisabled
      ? "Укажите ID отдела в настройках расширения"
      : "Фильтр: спринт + мой отдел",
  });
  const mineItem = createToolbarItem("Моя доска", "assignee", {
    disabled: false,
    active: active === "assignee",
    title: "Фильтр: спринт + назначенные мне",
  });

  filterItem.after(deptItem, mineItem);
}

function scheduleSync(): void {
  if (injectTimer != null) window.clearTimeout(injectTimer);
  injectTimer = window.setTimeout(() => {
    injectTimer = null;
    // Warm sprint cache when URL already has it
    const boardId = boardIdFromPath();
    const sprint = getFilterValues(parseQueryProps(), "sprint");
    if (boardId && sprint?.length) cacheSprintValues(boardId, sprint);
    syncToolbarButtons();
  }, 200);
}

export function refreshBoardFilters(): void {
  scheduleSync();
}

export function initBoardFilters(getSettings: () => Settings | null): void {
  settingsGetter = getSettings;
  scheduleSync();

  const observer = new MutationObserver(() => {
    if (!isBoardPage()) return;
    if (document.querySelector(`[${TOOLBAR_ATTR}]`) && findFilterToolbarItem()) {
      // Keep active/disabled state in sync when toolbar re-renders
      scheduleSync();
      return;
    }
    scheduleSync();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("popstate", scheduleSync);
}
