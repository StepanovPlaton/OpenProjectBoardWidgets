import { STORAGE_KEY, loadSettings } from "../shared/settings";
import { sendMessage } from "../shared/messaging";
import type { BackgroundResponse, Settings } from "../shared/types";
import { initBoardFilters, refreshBoardFilters } from "./boardFilters";
import { findBoardCards, diagnoseCardDom, isExtensionNode } from "./cards";
import { initOverviewEnhancer, refreshOverviewEnhancer } from "./overview";
import { applySettingsToDom, renderCard } from "./render";

const LOG = "[op-board-ext]";
const DEBOUNCE_MS = 400;
/** Keep batches small so MV3 service worker can answer before the port closes. */
const ENRICH_CHUNK = 30;
const STALE_POLL_MS = 60_000;
const RETRY_FAILED_MS = 5_000;
/** Angular board often paints after first scan — keep polling briefly. */
const EMPTY_BOARD_RETRY_MS = 1_000;
const EMPTY_BOARD_RETRY_MAX = 45;

let settings: Settings | null = null;
let debounceTimer: number | null = null;
let enrichInFlight = false;
let pendingIds = new Set<number>();
/** Cards already enriched this page session — don't re-fetch unless settings change */
const enrichedIds = new Set<number>();
const failedIds = new Set<number>();
let baselineHash: string | null = null;
let staleBannerShown = false;
let observerPaused = false;
let staleTimer: number | null = null;
let retryTimer: number | null = null;
let emptyBoardRetries = 0;
let emptyBoardTimer: number | null = null;

function isOpenProjectHost(): boolean {
  const path = location.pathname;
  return (
    path.includes("/boards") ||
    path.includes("/work_packages") ||
    document.querySelector("wp-single-card, .op-wp-single-card, [data-test-selector='op-wp-single-card']") !=
      null
  );
}

function logMessagingError(error: unknown, context: string): void {
  const message = error instanceof Error ? error.message : String(error);
  if (/extension context invalidated|receiving end does not exist/i.test(message)) {
    console.warn(`${LOG} ${context}: расширение перезагружено — обновите страницу доски (F5).`, error);
    return;
  }
  console.warn(`${LOG} ${context}:`, message, error);
}

async function refreshSettings(): Promise<void> {
  settings = await loadSettings();
  console.log(`${LOG} settings loaded`, {
    baseUrl: settings.connection.baseUrl,
    hasToken: Boolean(settings.connection.token?.trim()),
    widgets: {
      priority: settings.priority.enabled,
      department: settings.department.enabled,
      storyPoints: settings.storyPoints.enabled,
      blockers: settings.blockers.enabled,
      columnTime: settings.columnTime.enabled,
    },
  });
  applySettingsToDom(settings);
  refreshBoardFilters();
}

function withObserverPaused(fn: () => void): void {
  observerPaused = true;
  try {
    fn();
  } finally {
    window.setTimeout(() => {
      observerPaused = false;
    }, 50);
  }
}

function scheduleFailedRetry(): void {
  if (retryTimer != null || failedIds.size === 0) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    for (const id of failedIds) {
      pendingIds.add(id);
    }
    failedIds.clear();
    console.log(`${LOG} retrying failed cards`, { count: pendingIds.size });
    void processPending();
  }, RETRY_FAILED_MS);
}

async function enrichAndRender(ids: number[]): Promise<void> {
  if (ids.length === 0 || !settings) return;

  console.log(`${LOG} enrich request`, { ids });

  try {
    const response = await sendMessage<BackgroundResponse>({
      type: "ENRICH_CARDS",
      ids,
    });

    if (!response.ok) {
      console.warn(`${LOG} enrich failed`, response.error, response.code);
      ids.forEach((id) => failedIds.add(id));
      scheduleFailedRetry();
      return;
    }
    if (!("enrichments" in response)) {
      console.warn(`${LOG} enrich response without enrichments`, response);
      return;
    }

    const enrichmentKeys = Object.keys(response.enrichments);
    console.log(`${LOG} enrich response`, {
      requested: ids.length,
      received: enrichmentKeys.length,
      ids: enrichmentKeys,
    });

    const cards = findBoardCards();
    const byId = new Map(cards.map((c) => [c.workPackageId, c]));

    withObserverPaused(() => {
      for (const id of ids) {
        const card = byId.get(id);
        const enrichment = response.enrichments[String(id)];
        if (!card) {
          console.warn(`${LOG} card #${id}: DOM node not found after enrich`);
          failedIds.add(id);
          continue;
        }
        if (!enrichment) {
          console.warn(`${LOG} card #${id}: no enrichment payload`);
          failedIds.add(id);
          continue;
        }
        if (!settings) continue;

        renderCard(card, enrichment, settings);
        enrichedIds.add(id);
        failedIds.delete(id);
        console.log(`${LOG} card #${id} loaded`, {
          subject: enrichment.workPackage.subject,
          department: enrichment.departmentLabel || null,
          priority: enrichment.priorityPosition != null ? `P${enrichment.priorityPosition}` : null,
          sp: enrichment.storyPoints,
          blockersOk: enrichment.blockersOk,
          columnTime: enrichment.columnTimeText,
        });
      }
    });

    scheduleFailedRetry();
  } catch (error) {
    ids.forEach((id) => failedIds.add(id));
    logMessagingError(error, "ENRICH_CARDS");
    scheduleFailedRetry();
  }
}

async function processPending(): Promise<void> {
  if (enrichInFlight) return;
  enrichInFlight = true;
  try {
    while (pendingIds.size > 0) {
      const batch = [...pendingIds].slice(0, ENRICH_CHUNK);
      batch.forEach((id) => pendingIds.delete(id));
      console.log(`${LOG} processing batch`, { batch, remaining: pendingIds.size });
      await enrichAndRender(batch);
    }
  } finally {
    enrichInFlight = false;
    if (pendingIds.size > 0) {
      void processPending();
    }
  }
}

function scheduleScan(): void {
  if (debounceTimer != null) {
    window.clearTimeout(debounceTimer);
  }
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void scanNewCardsOnly();
  }, DEBOUNCE_MS);
}

/** Enrich only cards that are not yet enriched (no continuous refresh). */
async function scanNewCardsOnly(): Promise<void> {
  try {
    if (!settings) await refreshSettings();
    if (!settings) {
      console.warn(`${LOG} scan aborted: no settings`);
      return;
    }
    if (!settings.connection.token?.trim()) {
      console.warn(`${LOG} scan aborted: API token empty — откройте popup расширения и сохраните токен`);
      return;
    }

    const cards = findBoardCards();
    console.log(`${LOG} scan`, {
      found: cards.length,
      alreadyEnriched: enrichedIds.size,
      ids: cards.map((c) => c.workPackageId),
    });
    if (cards.length === 0) {
      const diag = diagnoseCardDom();
      console.warn(`${LOG} no cards yet — DOM probe`, diag);
      if (emptyBoardRetries < EMPTY_BOARD_RETRY_MAX) {
        emptyBoardRetries += 1;
        if (emptyBoardTimer != null) window.clearTimeout(emptyBoardTimer);
        emptyBoardTimer = window.setTimeout(() => {
          emptyBoardTimer = null;
          console.log(`${LOG} empty-board retry ${emptyBoardRetries}/${EMPTY_BOARD_RETRY_MAX}`);
          void scanNewCardsOnly();
        }, EMPTY_BOARD_RETRY_MS);
      }
      return;
    }
    emptyBoardRetries = 0;

    let added = false;
    for (const card of cards) {
      if (!enrichedIds.has(card.workPackageId) && !failedIds.has(card.workPackageId)) {
        pendingIds.add(card.workPackageId);
        added = true;
      }
    }
    if (added) {
      console.log(`${LOG} queued for enrich`, { count: pendingIds.size, ids: [...pendingIds] });
      await processPending();
    } else {
      console.log(`${LOG} nothing new to enrich`);
    }

    if (baselineHash == null && enrichedIds.size > 0) {
      await captureBaseline();
    }
  } catch (error) {
    logMessagingError(error, "scan");
  }
}

async function captureBaseline(): Promise<void> {
  const ids = findBoardCards().map((c) => c.workPackageId);
  if (ids.length === 0) return;

  try {
    const response = await sendMessage<BackgroundResponse>({
      type: "BOARD_SNAPSHOT",
      ids,
    });
    if (response.ok && "snapshotHash" in response) {
      baselineHash = response.snapshotHash;
      console.log(`${LOG} baseline hash`, baselineHash);
    }
  } catch (error) {
    logMessagingError(error, "BOARD_SNAPSHOT baseline");
  }
}

async function checkBoardStale(): Promise<void> {
  if (!settings?.connection.token || baselineHash == null || staleBannerShown) return;
  if (document.visibilityState !== "visible") return;

  const ids = findBoardCards().map((c) => c.workPackageId);
  if (ids.length === 0) return;

  try {
    const response = await sendMessage<BackgroundResponse>({
      type: "BOARD_SNAPSHOT",
      ids,
    });
    if (!response.ok || !("snapshotHash" in response)) return;

    if (response.snapshotHash !== baselineHash) {
      console.log(`${LOG} board stale`, { baselineHash, current: response.snapshotHash });
      showStaleBanner();
    }
  } catch (error) {
    logMessagingError(error, "BOARD_SNAPSHOT poll");
  }
}

function showStaleBanner(): void {
  if (staleBannerShown) return;
  staleBannerShown = true;

  const existing = document.getElementById("op-board-ext-stale-banner");
  if (existing) return;

  const banner = document.createElement("div");
  banner.id = "op-board-ext-stale-banner";
  banner.className = "op-board-ext-stale";

  const text = document.createElement("span");
  text.textContent = "Доска устарела — данные на сервере изменились";

  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "op-board-ext-stale-reload";
  reload.textContent = "Обновить";
  reload.addEventListener("click", () => location.reload());

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "op-board-ext-stale-dismiss";
  dismiss.textContent = "Скрыть";
  dismiss.addEventListener("click", () => banner.remove());

  banner.append(text, reload, dismiss);
  document.documentElement.appendChild(banner);
}

function mutationLooksRelevant(mutations: MutationRecord[]): boolean {
  for (const mutation of mutations) {
    if (mutation.type !== "childList") continue;

    for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
      if (isExtensionNode(node)) continue;
      if (!(node instanceof Element)) continue;
      if (
        node.matches?.(
          "wp-single-card, [data-work-package-id], [data-test-selector='op-wp-single-card'], .op-wp-single-card",
        ) ||
        node.querySelector?.(
          "wp-single-card, [data-work-package-id], [data-test-selector='op-wp-single-card'], .op-wp-single-card",
        )
      ) {
        return true;
      }
      // Board column / lists often mount as wrappers first
      if (
        node.matches?.("[class*='board'], [class*='wp-card'], boards-list, wp-card") ||
        node.querySelector?.("[class*='board'], [class*='wp-card'], wp-single-card, [data-work-package-id]")
      ) {
        return true;
      }
    }
  }
  return false;
}

function startObserver(): void {
  const observer = new MutationObserver((mutations) => {
    if (observerPaused) return;
    if (!mutationLooksRelevant(mutations)) return;

    for (const card of findBoardCards()) {
      if (!card.root.hasAttribute("data-op-ext-fp")) {
        enrichedIds.delete(card.workPackageId);
      }
    }
    scheduleScan();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function startStalePoll(): void {
  if (staleTimer != null) window.clearInterval(staleTimer);
  staleTimer = window.setInterval(() => {
    void checkBoardStale();
  }, STALE_POLL_MS);
}

async function init(): Promise<void> {
  console.log(`${LOG} content script init`, { href: location.href, hostOk: isOpenProjectHost() });

  if (!isOpenProjectHost()) {
    console.log(`${LOG} waiting for OpenProject board DOM…`);
    const late = new MutationObserver(() => {
      if (isOpenProjectHost()) {
        late.disconnect();
        console.log(`${LOG} board detected, booting`);
        void boot();
      }
    });
    late.observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  await boot();
}

async function boot(): Promise<void> {
  console.log(`${LOG} boot start`);
  try {
    await refreshSettings();
  } catch (error) {
    logMessagingError(error, "boot settings");
  }
  startObserver();
  scheduleScan();
  startStalePoll();
  initBoardFilters(() => settings);
  initOverviewEnhancer(() => settings);
  refreshOverviewEnhancer();
  console.log(`${LOG} boot ready (observer + scan scheduled)`);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[STORAGE_KEY]) {
      void (async () => {
        try {
          console.log(`${LOG} settings changed in storage — reloading`);
          await refreshSettings();
          enrichedIds.clear();
          failedIds.clear();
          baselineHash = null;
          staleBannerShown = false;
          document.getElementById("op-board-ext-stale-banner")?.remove();
          await sendMessage({ type: "CLEAR_CACHE" });
          scheduleScan();
          refreshBoardFilters();
          refreshOverviewEnhancer();
        } catch (error) {
          logMessagingError(error, "settings change");
        }
      })();
    }
  });
}

void init();
