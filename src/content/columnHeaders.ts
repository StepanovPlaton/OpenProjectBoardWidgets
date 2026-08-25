import type { Settings, WipLimitRule } from "../shared/types";
import { getActiveWipLimits } from "../shared/settings";
import { findBoardCards, type BoardCard } from "./cards";

const STATS_CLASS = "op-board-ext-column-stats";
const COUNT_CLASS = "op-board-ext-column-count";
const WIP_AT_CLASS = "op-board-ext-wip-at";
const WIP_OVER_CLASS = "op-board-ext-wip-over";
const COLUMN_WIP_OVER_CLASS = "op-board-ext-column-wip-over";
const HEADER_SELECTOR =
  ".op-board-list--header, [data-test-selector='op-board-list--header']";
const COLUMN_SELECTOR = "boards-list, .op-board-list, [data-test-selector='op-board-list']";
const SP_ATTR = "data-op-ext-sp";

const LIGHTBULB_SVG = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path fill-rule="evenodd" clip-rule="evenodd" d="M10.0512 15.75L9.51642 14.2768L9.18821 14.0137C8.15637 13.1865 7.5 11.9204 7.5 10.5C7.5 8.01472 9.51472 6 12 6C14.4853 6 16.5 8.01472 16.5 10.5C16.5 11.9204 15.8436 13.1865 14.8118 14.0137L14.4836 14.2768L13.9488 15.75H10.0512ZM9 17.25H15L15.75 15.184C17.1217 14.0844 18 12.3948 18 10.5C18 7.18629 15.3137 4.5 12 4.5C8.68629 4.5 6 7.18629 6 10.5C6 12.3948 6.87831 14.0844 8.25 15.184L9 17.25ZM14.25 19.5V18H9.75V19.5H14.25Z" fill="currentColor"></path>
</svg>
`.trim();

const CARD_COUNT_SVG = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M2 8.50488H22" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"></path>
  <path d="M6 16.5049H8" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"></path>
  <path d="M10.5 16.5049H14.5" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"></path>
  <path d="M6.44 3.50488H17.55C21.11 3.50488 22 4.38488 22 7.89488V16.1049C22 19.6149 21.11 20.4949 17.56 20.4949H6.44C2.89 20.5049 2 19.6249 2 16.1149V7.89488C2 4.38488 2.89 3.50488 6.44 3.50488Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
</svg>
`.trim();

function columnRootFor(el: HTMLElement): HTMLElement | null {
  const host = el.closest(COLUMN_SELECTOR);
  if (!(host instanceof HTMLElement)) return null;
  // Header itself can match class* patterns — require it to contain the header child
  if (host.matches(HEADER_SELECTOR)) return host.parentElement;
  return host;
}

function findColumnHeaders(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(HEADER_SELECTOR)];
}

function cardsInColumn(header: HTMLElement): BoardCard[] {
  const column = columnRootFor(header) ?? header.parentElement;
  if (!column) return [];
  return findBoardCards(column).filter((card) => {
    const nearestHeader = columnRootFor(card.root)?.querySelector<HTMLElement>(HEADER_SELECTOR);
    return nearestHeader === header;
  });
}

function readCardSp(card: BoardCard): number {
  const raw = card.root.getAttribute(SP_ATTR);
  if (raw == null || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function formatSpSum(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function columnStatusName(header: HTMLElement): string {
  const column = columnRootFor(header);
  const fromAttr = column?.getAttribute("data-query-name")?.trim();
  if (fromAttr) return fromAttr;

  const title = header.querySelector(
    ".editable-toolbar-title--fixed, .op-status-board-header h2, h2",
  );
  if (!title) return "";
  // Drop the small "Статус" label; keep the status line text.
  const clone = title.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("small, br").forEach((node) => node.remove());
  return clone.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function resolveWipLimit(statusName: string, rules: WipLimitRule[]): number | null {
  if (!statusName || rules.length === 0) return null;
  const haystack = statusName.toLowerCase();
  for (const rule of rules) {
    const needle = rule.match.trim().toLowerCase();
    if (!needle) continue;
    if (haystack.includes(needle) && Number.isFinite(rule.limit) && rule.limit > 0) {
      return Math.floor(rule.limit);
    }
  }
  return null;
}

function ensureStatsMount(header: HTMLElement): HTMLElement {
  let mount = header.querySelector<HTMLElement>(`:scope > .${STATS_CLASS}`);
  if (!mount) {
    mount = document.createElement("div");
    mount.className = STATS_CLASS;
    const menu = header.querySelector(
      ".op-board-list--menu, [data-test-selector='op-board-list--menu'], board-list-menu",
    );
    if (menu) {
      menu.before(mount);
    } else {
      header.appendChild(mount);
    }
  }
  return mount;
}

function renderBadge(
  mount: HTMLElement,
  className: string,
  iconHtml: string,
  iconClass: string,
  value: string,
  title: string,
): HTMLElement {
  let badge = mount.querySelector<HTMLElement>(`:scope > .${className}`);
  if (!badge) {
    badge = document.createElement("span");
    badge.className = className;
    mount.appendChild(badge);
  }

  badge.title = title;
  badge.replaceChildren();

  const icon = document.createElement("span");
  icon.className = iconClass;
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = iconHtml;

  const num = document.createElement("span");
  num.className = `${className}-value`;
  num.textContent = value;

  badge.append(icon, num);
  return badge;
}

/** Outer drag wrapper that owns column spacing — better place for side borders. */
function boardListItemFor(column: HTMLElement | null): HTMLElement | null {
  if (!column) return null;
  const item = column.closest(".boards-list--item");
  return item instanceof HTMLElement ? item : null;
}

function applyWipState(
  column: HTMLElement | null,
  countBadge: HTMLElement,
  count: number,
  limit: number | null,
  wipEnabled: boolean,
  borderEnabled: boolean,
): void {
  const borderTarget = boardListItemFor(column) ?? column;
  countBadge.classList.remove(WIP_AT_CLASS, WIP_OVER_CLASS);
  borderTarget?.classList.remove(COLUMN_WIP_OVER_CLASS);
  // Clear legacy class from inner column if it was applied earlier.
  if (column && column !== borderTarget) {
    column.classList.remove(COLUMN_WIP_OVER_CLASS);
  }

  if (!wipEnabled || limit == null) return;

  if (count > limit) {
    countBadge.classList.add(WIP_OVER_CLASS);
    if (borderEnabled && borderTarget) {
      borderTarget.classList.add(COLUMN_WIP_OVER_CLASS);
    }
  } else if (count === limit) {
    countBadge.classList.add(WIP_AT_CLASS);
  }
}

/** Store SP on the card root so column headers can sum without re-fetching. */
export function setCardStoryPointsAttr(root: HTMLElement, storyPoints: number | null): void {
  if (storyPoints != null && Number.isFinite(storyPoints)) {
    root.setAttribute(SP_ATTR, String(storyPoints));
  } else {
    root.removeAttribute(SP_ATTR);
  }
}

export function refreshColumnHeaders(settings: Settings | null): void {
  const headers = findColumnHeaders();
  if (headers.length === 0) return;

  const showSp = settings?.storyPoints.enabled !== false;
  const wipEnabled = settings?.wip.enabled === true;
  const borderEnabled = settings?.wip.borderEnabled === true;
  const limits = settings ? getActiveWipLimits(settings.wip) : [];

  for (const header of headers) {
    const column = columnRootFor(header);
    const cards = cardsInColumn(header);
    const count = cards.length;
    const spSum = cards.reduce((sum, card) => sum + readCardSp(card), 0);
    const mount = ensureStatsMount(header);

    if (showSp) {
      renderBadge(
        mount,
        "op-board-ext-column-sp",
        LIGHTBULB_SVG,
        "op-board-ext-sp-icon",
        formatSpSum(spSum),
        `Сумма Story Points в колонке: ${formatSpSum(spSum)}`,
      );
    } else {
      mount.querySelector(":scope > .op-board-ext-column-sp")?.remove();
    }

    const statusName = columnStatusName(header);
    const limit = wipEnabled ? resolveWipLimit(statusName, limits) : null;
    const countLabel = limit != null ? `${count}/${limit}` : String(count);
    const countTitle =
      limit != null
        ? `Карточек в колонке: ${count} (WIP-лимит: ${limit})`
        : `Карточек в колонке: ${count}`;

    const countBadge = renderBadge(
      mount,
      COUNT_CLASS,
      CARD_COUNT_SVG,
      "op-board-ext-column-count-icon",
      countLabel,
      countTitle,
    );

    applyWipState(column, countBadge, count, limit, wipEnabled, borderEnabled);

    // Keep order: SP on top, card count below
    const sp = mount.querySelector<HTMLElement>(":scope > .op-board-ext-column-sp");
    const cnt = mount.querySelector<HTMLElement>(`:scope > .${COUNT_CLASS}`);
    if (sp && cnt && sp.nextElementSibling !== cnt) {
      mount.append(sp, cnt);
    } else if (cnt && !sp) {
      mount.appendChild(cnt);
    }
  }
}
