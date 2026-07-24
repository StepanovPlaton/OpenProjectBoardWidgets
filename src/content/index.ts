import { STORAGE_KEY, loadSettings } from "../shared/settings";
import { sendMessage } from "../shared/messaging";
import type { BackgroundResponse, CardEnrichment, CardLazyEnrichment, Settings } from "../shared/types";
import { initBoardFilters, refreshBoardFilters } from "./boardFilters";
import { findBoardCards, diagnoseCardDom, isExtensionNode } from "./cards";
import { initOverviewEnhancer, refreshOverviewEnhancer } from "./overview";
import { applySettingsToDom, cardNeedsRestore, renderCard } from "./render";
import { refreshColumnHeaders, setCardStoryPointsAttr } from "./columnHeaders";
import {
  initNotifications,
  refreshNotificationBadgesOnly,
  refreshNotifications,
} from "./notifications";

const LOG = "[op-board-ext]";
const DEBOUNCE_MS = 400;
/** Larger batches — tier-1 is a single filters=id request (up to 100). */
const ENRICH_CHUNK = 50;
const LAZY_CHUNK = 40;
const RETRY_FAILED_MS = 5_000;
/** Angular board often paints after first scan — keep polling briefly. */
const EMPTY_BOARD_RETRY_MS = 1_000;
const EMPTY_BOARD_RETRY_MAX = 45;

let settings: Settings | null = null;
let debounceTimer: number | null = null;
let enrichInFlight = false;
let lazyInFlight = false;
let pendingIds = new Set<number>();
let pendingLazyIds = new Set<number>();
/** Cards that already received tier-1 (WP fields). */
const enrichedIds = new Set<number>();
/** Cards that already received a successful tier-2 pass. */
const lazyDoneIds = new Set<number>();
const failedIds = new Set<number>();
/** Last known enrichment per WP — used to restore widgets after Angular DnD re-renders. */
const enrichmentCache = new Map<number, CardEnrichment>();
let observerPaused = false;
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
      reworkReturns: settings.reworkReturns.enabled,
      columnTime: settings.columnTime.enabled,
      notifications: settings.notifications.enabled,
    },
  });
  applySettingsToDom(settings);
  refreshBoardFilters();
  refreshColumnHeaders(settings);
  refreshNotifications(false);
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

async function enrichAndRender(ids: number[], force = false): Promise<void> {
  if (ids.length === 0 || !settings) return;

  console.log(`${LOG} enrich FAST request`, { ids, force });

  try {
    const response = await sendMessage<BackgroundResponse>({
      type: "ENRICH_CARDS",
      ids,
      force,
    });

    if (!response.ok) {
      console.warn(`${LOG} enrich FAST failed`, response.error, response.code);
      ids.forEach((id) => failedIds.add(id));
      scheduleFailedRetry();
      return;
    }
    if (!("enrichments" in response)) {
      console.warn(`${LOG} enrich FAST response without enrichments`, response);
      return;
    }

    console.log(`${LOG} enrich FAST response`, {
      requested: ids.length,
      received: Object.keys(response.enrichments).length,
    });

    const cards = findBoardCards();
    const byId = new Map(cards.map((c) => [c.workPackageId, c]));
    const okIds: number[] = [];

    withObserverPaused(() => {
      let appearIndex = 0;
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

        const prev = enrichmentCache.get(id);
        const merged: CardEnrichment = prev
          ? {
              ...enrichment,
              // Keep any already-loaded lazy fields if we re-ran FAST
              ciSummary: enrichment.ciSummary ?? prev.ciSummary,
              blockersOk: enrichment.blockersOk ?? prev.blockersOk,
              columnTimeText: enrichment.columnTimeText ?? prev.columnTimeText,
              reworkReturns: enrichment.reworkReturns ?? prev.reworkReturns,
            }
          : enrichment;

        const enterDelayMs = Math.min(appearIndex * 20, 300);
        appearIndex += 1;
        renderCard(card, merged, settings, { enterDelayMs });
        setCardStoryPointsAttr(card.root, merged.workPackage.storyPoints);
        enrichmentCache.set(id, merged);
        enrichedIds.add(id);
        failedIds.delete(id);
        okIds.push(id);
      }
    });

    refreshColumnHeaders(settings);
    refreshNotificationBadgesOnly();
    scheduleFailedRetry();

    // Kick tier-2 without blocking the next FAST batch
    for (const id of okIds) {
      if (!lazyDoneIds.has(id)) pendingLazyIds.add(id);
    }
    void processLazyPending();
  } catch (error) {
    ids.forEach((id) => failedIds.add(id));
    logMessagingError(error, "ENRICH_CARDS");
    scheduleFailedRetry();
  }
}

function mergeLazy(
  base: CardEnrichment,
  lazy: CardLazyEnrichment,
): CardEnrichment {
  return {
    ...base,
    ciSummary: lazy.ciSummary,
    blockersOk: lazy.blockersOk,
    columnTimeText: lazy.columnTimeText,
    reworkReturns: lazy.reworkReturns,
  };
}

async function enrichLazyAndRender(ids: number[]): Promise<void> {
  if (ids.length === 0 || !settings) return;

  console.log(`${LOG} enrich LAZY request`, { ids });

  try {
    const response = await sendMessage<BackgroundResponse>({
      type: "ENRICH_CARDS_LAZY",
      ids,
    });

    if (!response.ok) {
      console.warn(`${LOG} enrich LAZY failed`, response.error, response.code);
      return;
    }
    if (!("lazyEnrichments" in response)) {
      console.warn(`${LOG} enrich LAZY response without payload`, response);
      return;
    }

    console.log(`${LOG} enrich LAZY response`, {
      requested: ids.length,
      received: Object.keys(response.lazyEnrichments).length,
    });

    const cards = findBoardCards();
    const byId = new Map(cards.map((c) => [c.workPackageId, c]));

    withObserverPaused(() => {
      for (const id of ids) {
        const lazy = response.lazyEnrichments[String(id)];
        const prev = enrichmentCache.get(id);
        if (!lazy || !prev || !settings) continue;

        const merged = mergeLazy(prev, lazy);
        enrichmentCache.set(id, merged);
        lazyDoneIds.add(id);

        const card = byId.get(id);
        if (card) {
          renderCard(card, merged, settings, { force: true });
          setCardStoryPointsAttr(card.root, merged.workPackage.storyPoints);
        }
      }
    });

    refreshColumnHeaders(settings);
    refreshNotificationBadgesOnly();
  } catch (error) {
    logMessagingError(error, "ENRICH_CARDS_LAZY");
  }
}

async function processPending(forceIds?: Set<number>): Promise<void> {
  if (enrichInFlight) return;
  enrichInFlight = true;
  try {
    while (pendingIds.size > 0) {
      const batch = [...pendingIds].slice(0, ENRICH_CHUNK);
      batch.forEach((id) => pendingIds.delete(id));
      const forceBatch = forceIds ? batch.filter((id) => forceIds.has(id)) : [];
      const normalBatch = forceIds ? batch.filter((id) => !forceIds.has(id)) : batch;
      if (forceBatch.length > 0) {
        console.log(`${LOG} processing FAST batch (force)`, { batch: forceBatch });
        await enrichAndRender(forceBatch, true);
      }
      if (normalBatch.length > 0) {
        console.log(`${LOG} processing FAST batch`, {
          batch: normalBatch,
          remaining: pendingIds.size,
        });
        await enrichAndRender(normalBatch, false);
      }
    }
  } finally {
    enrichInFlight = false;
    if (pendingIds.size > 0) {
      void processPending(forceIds);
    }
  }
}

async function processLazyPending(): Promise<void> {
  if (lazyInFlight) return;
  lazyInFlight = true;
  try {
    while (pendingLazyIds.size > 0) {
      const batch = [...pendingLazyIds].slice(0, LAZY_CHUNK);
      batch.forEach((id) => pendingLazyIds.delete(id));
      console.log(`${LOG} processing LAZY batch`, { batch, remaining: pendingLazyIds.size });
      await enrichLazyAndRender(batch);
    }
  } finally {
    lazyInFlight = false;
    if (pendingLazyIds.size > 0) {
      void processLazyPending();
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
    const restored: number[] = [];
    const forceRefresh = new Set<number>();

    withObserverPaused(() => {
      for (const card of cards) {
        const cached = enrichmentCache.get(card.workPackageId);
        if (cached && cardNeedsRestore(card.root, cached, settings!)) {
          // Angular DnD often rewrites card DOM and drops our widgets — restore instantly
          renderCard(card, cached, settings!, { force: true });
          setCardStoryPointsAttr(card.root, cached.workPackage.storyPoints);
          enrichmentCache.set(card.workPackageId, cached);
          enrichedIds.add(card.workPackageId);
          restored.push(card.workPackageId);
          // Status may have changed after a move — refresh WP + lazy fields
          forceRefresh.add(card.workPackageId);
          lazyDoneIds.delete(card.workPackageId);
          pendingIds.add(card.workPackageId);
          added = true;
          continue;
        }

        if (!enrichedIds.has(card.workPackageId) && !failedIds.has(card.workPackageId)) {
          pendingIds.add(card.workPackageId);
          added = true;
        } else if (
          enrichedIds.has(card.workPackageId) &&
          !lazyDoneIds.has(card.workPackageId) &&
          !pendingLazyIds.has(card.workPackageId)
        ) {
          pendingLazyIds.add(card.workPackageId);
        }
      }
    });

    if (restored.length > 0) {
      console.log(`${LOG} restored widgets after DOM wipe`, { count: restored.length, ids: restored });
      refreshColumnHeaders(settings);
    }

    if (added) {
      console.log(`${LOG} queued for enrich`, { count: pendingIds.size, ids: [...pendingIds] });
      await processPending(forceRefresh);
    } else {
      console.log(`${LOG} nothing new to enrich`);
      void processLazyPending();
    }
    refreshColumnHeaders(settings);
    refreshNotificationBadgesOnly();
  } catch (error) {
    logMessagingError(error, "scan");
  }
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
        continue;
      }
      // Fingerprint can survive on the host while Angular wipes inner widgets (DnD)
      const cached = enrichmentCache.get(card.workPackageId);
      if (cached && settings && cardNeedsRestore(card.root, cached, settings)) {
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
  initBoardFilters(() => settings);
  initOverviewEnhancer(() => settings);
  initNotifications(() => settings);
  refreshOverviewEnhancer();
  console.log(`${LOG} boot ready (observer + scan scheduled)`);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[STORAGE_KEY]) {
      void (async () => {
        try {
          console.log(`${LOG} settings changed in storage — reloading`);
          await refreshSettings();
          enrichedIds.clear();
          lazyDoneIds.clear();
          failedIds.clear();
          enrichmentCache.clear();
          pendingLazyIds.clear();
          await sendMessage({ type: "CLEAR_CACHE" });
          scheduleScan();
          refreshBoardFilters();
          refreshOverviewEnhancer();
          refreshColumnHeaders(settings);
          refreshNotifications(false);
        } catch (error) {
          logMessagingError(error, "settings change");
        }
      })();
    }
  });
}

void init();
