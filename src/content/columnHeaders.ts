import type { Settings } from "../shared/types";
import { findBoardCards, type BoardCard } from "./cards";

const STATS_CLASS = "op-board-ext-column-stats";
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
): void {
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

  for (const header of headers) {
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

    renderBadge(
      mount,
      "op-board-ext-column-count",
      CARD_COUNT_SVG,
      "op-board-ext-column-count-icon",
      String(count),
      `Карточек в колонке: ${count}`,
    );

    // Keep order: SP on top, card count below
    const sp = mount.querySelector<HTMLElement>(":scope > .op-board-ext-column-sp");
    const cnt = mount.querySelector<HTMLElement>(":scope > .op-board-ext-column-count");
    if (sp && cnt && sp.nextElementSibling !== cnt) {
      mount.append(sp, cnt);
    } else if (cnt && !sp) {
      mount.appendChild(cnt);
    }
  }
}
