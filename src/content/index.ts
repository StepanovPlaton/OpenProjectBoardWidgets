import { STORAGE_KEY, loadSettings } from "../shared/settings";
import { sendMessage } from "../shared/messaging";
import type { BackgroundResponse, CardEnrichment, CardLazyEnrichment, Settings } from "../shared/types";
import { initBoardFilters, refreshBoardFilters } from "./boardFilters";
import { initCardEdits } from "./cardEdits";
import { findBoardCards, diagnoseCardDom, isExtensionNode } from "./cards";
import { initOverviewEnhancer, refreshOverviewEnhancer } from "./overview";
import { applySettingsToDom, cardNeedsRestore, diagnoseRestoreReasons, renderCard, snapshotCardWidgets } from "./render";
import { refreshColumnHeaders, setCardStoryPointsAttr } from "./columnHeaders";
import {
  initNotifications,
  refreshNotificationBadgesOnly,
  refreshNotifications,
} from "./notifications";

const LOG = "[op-board-ext]";
/** Filter DevTools console by this prefix when debugging column DnD wipes. */
const LOG_DND = "[op-board-ext:dnd]";
const DEBOUNCE_MS = 400;
/** Fast re-scan when Angular DnD wiped widgets mid-render. */
const WIPE_SCAN_MS = 50;
/** Larger batches — tier-1 is a single filters=id request (up to 100). */
const ENRICH_CHUNK = 50;
const LAZY_CHUNK = 40;
const RETRY_FAILED_MS = 5_000;
/** Angular board often paints after first scan — keep polling briefly. */
const EMPTY_BOARD_RETRY_MS = 1_000;
const EMPTY_BOARD_RETRY_MAX = 45;
/** Re-apply widgets after DnD — Angular often re-renders again after status PATCH. */
const RESTORE_RETRY_DELAYS_MS = [150, 450, 1100];
/** Throttle "mutation ignored while paused" spam. */
const PAUSED_MUTATION_LOG_MS = 200;

let settings: Settings | null = null;
let debounceTimer: number | null = null;
let enrichInFlight = false;
let lazyInFlight = false;
let pendingIds = new Set<number>();
let pendingLazyIds = new Set<number>();
/** Ids that must bypass WP cache (status change after DnD). */
const forcePendingIds = new Set<number>();
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
/** Pending delayed restore timers per work package id. */
const restoreRetryTimers = new Map<number, number[]>();
let lastPausedMutationLogAt = 0;
let pausedMutationBurst = 0;

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
      wip: settings.wip.enabled,
      wipBorder: settings.wip.borderEnabled,
    },
  });
  applySettingsToDom(settings);
  refreshBoardFilters();
  refreshColumnHeaders(settings);
  refreshNotifications(false);
}

function markWipedCardsForRescan(): boolean {
  if (!settings) return false;
  let needsScan = false;
  const wiped: Array<{ id: number; reasons: string[]; widgets: Record<string, string> }> = [];
  for (const card of findBoardCards()) {
    const cached = enrichmentCache.get(card.workPackageId);
    if (!cached) continue;
    if (cardNeedsRestore(card.root, cached, settings)) {
      enrichedIds.delete(card.workPackageId);
      needsScan = true;
      wiped.push({
        id: card.workPackageId,
        reasons: diagnoseRestoreReasons(card.root, cached, settings),
        widgets: snapshotCardWidgets(card.root),
      });
    }
  }
  if (wiped.length > 0) {
    console.warn(`${LOG_DND} wipe detected after observer unpause`, {
      count: wiped.length,
      wiped,
      t: performance.now().toFixed(1),
    });
  } else {
    console.log(`${LOG_DND} observer unpause — widgets intact`, {
      t: performance.now().toFixed(1),
    });
  }
  return needsScan;
}

function withObserverPaused(fn: () => void): void {
  observerPaused = true;
  console.log(`${LOG_DND} observer PAUSED`, { t: performance.now().toFixed(1) });
  try {
    fn();
  } finally {
    window.setTimeout(() => {
      observerPaused = false;
      console.log(`${LOG_DND} observer RESUMED`, {
        pausedMutationsDuringBurst: pausedMutationBurst,
        t: performance.now().toFixed(1),
      });
      pausedMutationBurst = 0;
      // Angular may wipe our inject while the observer was paused (DnD re-render).
      if (markWipedCardsForRescan()) {
        scheduleScan(WIPE_SCAN_MS);
      }
    }, 50);
  }
}

function restoreCardFromCache(workPackageId: number, reason: string): boolean {
  if (!settings) {
    console.log(`${LOG_DND} restore skip #${workPackageId}`, { reason, skip: "no-settings" });
    return false;
  }
  const cached = enrichmentCache.get(workPackageId);
  if (!cached) {
    console.warn(`${LOG_DND} restore skip #${workPackageId}`, {
      reason,
      skip: "no-cache",
      enriched: enrichedIds.has(workPackageId),
      t: performance.now().toFixed(1),
    });
    return false;
  }
  const card = findBoardCards().find((c) => c.workPackageId === workPackageId);
  if (!card) {
    console.warn(`${LOG_DND} restore skip #${workPackageId}`, {
      reason,
      skip: "card-not-in-dom",
      boardCardCount: findBoardCards().length,
      t: performance.now().toFixed(1),
    });
    return false;
  }

  const before = snapshotCardWidgets(card.root);
  const reasons = diagnoseRestoreReasons(card.root, cached, settings);
  if (reasons.length === 0) {
    console.log(`${LOG_DND} restore skip #${workPackageId}`, {
      reason,
      skip: "already-ok",
      widgets: before,
      t: performance.now().toFixed(1),
    });
    return false;
  }

  console.warn(`${LOG_DND} restore START #${workPackageId}`, {
    reason,
    reasons,
    widgetsBefore: before,
    hasCache: true,
    lazyDone: lazyDoneIds.has(workPackageId),
    t: performance.now().toFixed(1),
  });

  withObserverPaused(() => {
    renderCard(card, cached, settings!, { force: true, reason });
    setCardStoryPointsAttr(card.root, cached.workPackage.storyPoints);
    enrichmentCache.set(workPackageId, cached);
    enrichedIds.add(workPackageId);
  });

  const after = snapshotCardWidgets(card.root);
  const stillMissing = diagnoseRestoreReasons(card.root, cached, settings);
  if (stillMissing.length > 0) {
    console.error(`${LOG_DND} restore FAILED #${workPackageId}`, {
      reason,
      stillMissing,
      widgetsAfter: after,
      t: performance.now().toFixed(1),
    });
  } else {
    console.log(`${LOG_DND} restore OK #${workPackageId}`, {
      reason,
      widgetsAfter: after,
      t: performance.now().toFixed(1),
    });
  }
  return true;
}

function scheduleRestoreRetries(ids: number[]): void {
  console.log(`${LOG_DND} schedule delayed restores`, {
    ids,
    delaysMs: RESTORE_RETRY_DELAYS_MS,
    t: performance.now().toFixed(1),
  });
  for (const id of ids) {
    const prev = restoreRetryTimers.get(id);
    if (prev) {
      for (const t of prev) window.clearTimeout(t);
    }
    const timers: number[] = [];
    for (const delay of RESTORE_RETRY_DELAYS_MS) {
      timers.push(
        window.setTimeout(() => {
          console.log(`${LOG_DND} delayed restore tick #${id}`, {
            delayMs: delay,
            t: performance.now().toFixed(1),
          });
          const did = restoreCardFromCache(id, `delayed-restore:${delay}ms`);
          if (did) {
            refreshColumnHeaders(settings);
            refreshNotificationBadgesOnly();
          }
        }, delay),
      );
    }
    restoreRetryTimers.set(id, timers);
  }
}

function applyEnrichmentUpdate(workPackageId: number, enrichment: CardEnrichment): void {
  if (!settings) return;

  const prev = enrichmentCache.get(workPackageId);
  const merged: CardEnrichment = prev
    ? {
        ...enrichment,
        ciSummary: enrichment.ciSummary ?? prev.ciSummary,
        blockersOk: enrichment.blockersOk ?? prev.blockersOk,
        columnTimeText: enrichment.columnTimeText ?? prev.columnTimeText,
        reworkReturns: enrichment.reworkReturns ?? prev.reworkReturns,
      }
    : enrichment;

  enrichmentCache.set(workPackageId, merged);
  enrichedIds.add(workPackageId);

  const card = findBoardCards().find((c) => c.workPackageId === workPackageId);
  if (!card) return;

  console.log(`${LOG} applyEnrichmentUpdate #${workPackageId}`, {
    t: performance.now().toFixed(1),
    assigneeId: merged.workPackage.assigneeId,
    priorityId: merged.workPackage.priorityId,
    sp: merged.storyPoints,
  });

  withObserverPaused(() => {
    renderCard(card, merged, settings!, { force: true, reason: "applyEnrichmentUpdate" });
    setCardStoryPointsAttr(card.root, merged.workPackage.storyPoints);
  });

  refreshColumnHeaders(settings);
  refreshNotificationBadgesOnly();
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
        renderCard(card, merged, settings, {
          enterDelayMs,
          force,
          reason: force ? "enrichFAST:force" : "enrichFAST",
        });
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
      sample: Object.entries(response.lazyEnrichments)
        .slice(0, 3)
        .map(([id, lazy]) => ({
          id,
          ci: lazy.ciSummary,
          blockers: lazy.blockersOk,
          time: lazy.columnTimeText,
          rework: lazy.reworkReturns,
        })),
      t: performance.now().toFixed(1),
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
          renderCard(card, merged, settings, { lazyOnly: true, reason: "enrichLAZY" });
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
  if (forceIds) {
    for (const id of forceIds) forcePendingIds.add(id);
  }
  if (enrichInFlight) return;
  enrichInFlight = true;
  try {
    while (pendingIds.size > 0) {
      const batch = [...pendingIds].slice(0, ENRICH_CHUNK);
      batch.forEach((id) => pendingIds.delete(id));
      const forceBatch = batch.filter((id) => forcePendingIds.has(id));
      const normalBatch = batch.filter((id) => !forcePendingIds.has(id));
      forceBatch.forEach((id) => forcePendingIds.delete(id));
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
      void processPending();
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

function scheduleScan(delayMs = DEBOUNCE_MS): void {
  if (debounceTimer != null) {
    window.clearTimeout(debounceTimer);
  }
  console.log(`${LOG} scheduleScan in ${delayMs}ms`, { t: performance.now().toFixed(1) });
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    console.log(`${LOG} scanNewCardsOnly start`, { t: performance.now().toFixed(1) });
    void scanNewCardsOnly();
  }, delayMs);
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
          const reasons = diagnoseRestoreReasons(card.root, cached, settings!);
          console.warn(`${LOG_DND} scan wipe restore #${card.workPackageId}`, {
            reasons,
            widgetsBefore: snapshotCardWidgets(card.root),
            t: performance.now().toFixed(1),
          });
          // Angular DnD often rewrites card DOM and drops our widgets — restore instantly
          renderCard(card, cached, settings!, { force: true, reason: `scan:restore:${reasons.join(",")}` });
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
      console.warn(`${LOG_DND} scan restored after wipe`, {
        count: restored.length,
        ids: restored,
        willForceEnrich: [...forceRefresh],
        widgetsAfter: restored.map((id) => {
          const card = cards.find((c) => c.workPackageId === id);
          return card
            ? { id, widgets: snapshotCardWidgets(card.root) }
            : { id, widgets: null };
        }),
        t: performance.now().toFixed(1),
      });
      // Angular often re-renders the card again after the status change lands.
      scheduleRestoreRetries(restored);
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

function isInsideBoardCard(el: Element | null): boolean {
  if (!el) return false;
  if (el.hasAttribute("data-op-ext-fp") || el.classList.contains("op-board-ext-card")) return true;
  return (
    el.closest?.(
      "wp-single-card, [data-test-selector='op-wp-single-card'], [data-qa-selector='op-wp-single-card'], .op-wp-single-card, .op-board-ext-card",
    ) != null
  );
}

function mutationLooksRelevant(mutations: MutationRecord[]): boolean {
  for (const mutation of mutations) {
    if (mutation.type !== "childList") continue;

    // Inner re-render of an existing card (common after DnD / status PATCH)
    if (mutation.target instanceof Element && isInsideBoardCard(mutation.target)) {
      return true;
    }

    for (const node of mutation.removedNodes) {
      // Angular wiped our inject — do not ignore extension nodes here
      if (isExtensionNode(node)) return true;
    }

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

function summarizeMutations(mutations: MutationRecord[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const mutation of mutations.slice(0, 8)) {
    if (mutation.type !== "childList") continue;
    const describe = (node: Node): string => {
      if (isExtensionNode(node)) return `ext:${(node as Element).className?.toString?.().slice(0, 40) ?? "text"}`;
      if (node instanceof Element) {
        return `${node.tagName.toLowerCase()}.${(node.className?.toString?.() || "").slice(0, 40)}`;
      }
      return "text";
    };
    out.push({
      added: [...mutation.addedNodes].slice(0, 4).map(describe),
      removed: [...mutation.removedNodes].slice(0, 4).map(describe),
      target:
        mutation.target instanceof Element
          ? `${mutation.target.tagName.toLowerCase()}.${(mutation.target.className?.toString?.() || "").slice(0, 40)}`
          : "node",
    });
  }
  return out;
}

function startObserver(): void {
  const observer = new MutationObserver((mutations) => {
    if (observerPaused) {
      pausedMutationBurst += 1;
      const now = performance.now();
      if (now - lastPausedMutationLogAt >= PAUSED_MUTATION_LOG_MS) {
        lastPausedMutationLogAt = now;
        const extRemoved = mutations.some((m) =>
          [...m.removedNodes].some((n) => isExtensionNode(n)),
        );
        console.warn(`${LOG_DND} mutations IGNORED (observer paused)`, {
          burst: pausedMutationBurst,
          mutationCount: mutations.length,
          extWidgetsRemoved: extRemoved,
          sample: summarizeMutations(mutations),
          t: now.toFixed(1),
        });
      }
      return;
    }
    if (!mutationLooksRelevant(mutations)) return;

    const extRemoved = mutations.some((m) =>
      [...m.removedNodes].some((n) => isExtensionNode(n)),
    );
    const cardMoves = mutations.some((m) =>
      [...m.addedNodes, ...m.removedNodes].some(
        (n) =>
          n instanceof Element &&
          (n.matches?.("wp-single-card, [data-work-package-id], .op-wp-single-card") ||
            n.querySelector?.("wp-single-card, [data-work-package-id], .op-wp-single-card")),
      ),
    );

    console.log(`${LOG_DND} mutation relevant`, {
      t: performance.now().toFixed(1),
      count: mutations.length,
      extWidgetsRemoved: extRemoved,
      likelyCardMove: cardMoves,
      sample: summarizeMutations(mutations),
    });

    let wipeDetected = false;
    const wipedForce = new Set<number>();
    const boardCards = findBoardCards();
    for (const card of boardCards) {
      const hasFp = card.root.hasAttribute("data-op-ext-fp");
      if (!hasFp) {
        if (enrichmentCache.has(card.workPackageId) || enrichedIds.has(card.workPackageId)) {
          console.warn(`${LOG_DND} card lost fingerprint #${card.workPackageId}`, {
            widgets: snapshotCardWidgets(card.root),
            hadCache: enrichmentCache.has(card.workPackageId),
            t: performance.now().toFixed(1),
          });
        }
        enrichedIds.delete(card.workPackageId);
        wipeDetected = true;
        continue;
      }
      // Fingerprint can survive on the host while Angular wipes inner widgets (DnD)
      const cached = enrichmentCache.get(card.workPackageId);
      if (cached && settings && cardNeedsRestore(card.root, cached, settings)) {
        const reasons = diagnoseRestoreReasons(card.root, cached, settings);
        console.warn(`${LOG_DND} mutation wipe #${card.workPackageId}`, {
          reasons,
          widgets: snapshotCardWidgets(card.root),
          t: performance.now().toFixed(1),
        });
        enrichedIds.delete(card.workPackageId);
        wipeDetected = true;
        // Instant restore from cache — don't wait for debounce / API
        restoreCardFromCache(card.workPackageId, `mutation:instant:${reasons.join(",")}`);
        scheduleRestoreRetries([card.workPackageId]);
        lazyDoneIds.delete(card.workPackageId);
        pendingIds.add(card.workPackageId);
        wipedForce.add(card.workPackageId);
      }
    }

    if (!wipeDetected && (extRemoved || cardMoves)) {
      // Helpful when move happened but cardNeedsRestore said false
      const suspects = boardCards
        .filter((c) => enrichmentCache.has(c.workPackageId))
        .slice(0, 5)
        .map((c) => ({
          id: c.workPackageId,
          reasons: settings
            ? diagnoseRestoreReasons(c.root, enrichmentCache.get(c.workPackageId)!, settings)
            : [],
          widgets: snapshotCardWidgets(c.root),
          inEnriched: enrichedIds.has(c.workPackageId),
        }));
      console.log(`${LOG_DND} move/ext-remove without wipe flag`, {
        suspects,
        t: performance.now().toFixed(1),
      });
    }

    scheduleScan(wipeDetected ? WIPE_SCAN_MS : DEBOUNCE_MS);
    if (wipedForce.size > 0) {
      console.log(`${LOG_DND} queue force enrich after wipe`, {
        ids: [...wipedForce],
        t: performance.now().toFixed(1),
      });
      void processPending(wipedForce);
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  console.log(`${LOG_DND} MutationObserver started — filter console by "op-board-ext:dnd"`);
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
  initCardEdits({
    getSettings: () => settings,
    getEnrichment: (id) => enrichmentCache.get(id),
    applyEnrichment: applyEnrichmentUpdate,
    findCard: (id) => findBoardCards().find((c) => c.workPackageId === id),
  });
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
          forcePendingIds.clear();
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
