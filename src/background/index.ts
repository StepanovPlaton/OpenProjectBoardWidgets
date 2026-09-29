import { ApiError, OpenProjectClient } from "../shared/api/client";
import { fetchActivities, computeColumnTimeText } from "../shared/api/activities";
import {
  fetchGithubCiSummary,
  fetchGithubPullRequestOverview,
} from "../shared/api/githubPullRequests";
import { resolveBoardSprintValues } from "../shared/api/boardSprint";
import {
  fetchUnreadNotifications,
  markWorkPackageNotificationsRead,
} from "../shared/api/notifications";
import { fetchPriorities } from "../shared/api/priorities";
import { fetchRelations } from "../shared/api/relations";
import { fetchDepartmentOptions, fetchPopupSettingsOptions } from "../shared/api/settingsOptions";
import {
  fetchAvailableAssignees,
  updateWorkPackage,
} from "../shared/api/workPackages";
import { STORAGE_KEY, loadSettings, normalizeBaseUrl, saveSettings } from "../shared/settings";
import type {
  AssigneeOption,
  BackgroundRequest,
  BackgroundResponse,
  CardEnrichment,
  CardLazyEnrichment,
  CiSummary,
  GithubPullRequestOverviewItem,
  NotificationSummary,
  PriorityInfo,
  RelationOverviewItem,
  Settings,
  WorkPackageOverviewExtras,
  WorkPackagePatch,
  WorkPackageSummary,
} from "../shared/types";
import { computeBlockersOk } from "../shared/widgets/blockers";
import { formatDepartmentLabel } from "../shared/widgets/department";
import { resolvePriorityDisplay } from "../shared/widgets/priority";
import { resolveReviewColor } from "../shared/widgets/review";
import { countReworkReturns } from "../shared/widgets/reworkReturns";
import {
  clearWorkPackageStore,
  ensureWorkPackages,
  invalidateWorkPackages,
  peekWorkPackage,
  putWorkPackage,
  workPackageStoreStats,
} from "./store";

const PRIORITY_TTL_MS = 10 * 60_000;
const RELATIONS_TTL_MS = 3 * 60_000;
const ACTIVITIES_TTL_MS = 3 * 60_000;
const GITHUB_CI_TTL_MS = 2 * 60_000;
const NOTIFICATIONS_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const relationsCache = new Map<number, CacheEntry<number[]>>();
const activitiesCache = new Map<number, CacheEntry<Record<string, unknown>[]>>();
const githubCiCache = new Map<number, CacheEntry<CiSummary | null>>();
let prioritiesCache: CacheEntry<PriorityInfo[]> | null = null;
let notificationsCache: CacheEntry<NotificationSummary[]> | null = null;

function getCached<T>(map: Map<number, CacheEntry<T>>, id: number): T | null {
  const entry = map.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    map.delete(id);
    return null;
  }
  return entry.value;
}

function setCached<T>(map: Map<number, CacheEntry<T>>, id: number, value: T, ttl: number): void {
  map.set(id, { value, expiresAt: Date.now() + ttl });
}

function clearAllCaches(): void {
  clearWorkPackageStore();
  relationsCache.clear();
  activitiesCache.clear();
  githubCiCache.clear();
  prioritiesCache = null;
  notificationsCache = null;
}

function clientFromSettings(settings: Settings): OpenProjectClient {
  const baseUrl = normalizeBaseUrl(settings.connection.baseUrl);
  const token = settings.connection.token.trim();
  if (!baseUrl || !token) {
    throw new ApiError("Configure base URL and API token in the extension popup", 0, "CONFIG");
  }
  return OpenProjectClient.fromConnection(baseUrl, token);
}

async function getPriorities(client: OpenProjectClient): Promise<PriorityInfo[]> {
  if (prioritiesCache && Date.now() < prioritiesCache.expiresAt) {
    return prioritiesCache.value;
  }
  const priorities = await fetchPriorities(client);
  prioritiesCache = { value: priorities, expiresAt: Date.now() + PRIORITY_TTL_MS };
  return priorities;
}

function buildFastEnrichment(
  wp: WorkPackageSummary,
  settings: Settings,
  priorities: PriorityInfo[],
): CardEnrichment {
  const { position, color } = settings.priority.enabled
    ? resolvePriorityDisplay(wp.priorityId, wp.priorityName, priorities)
    : { position: null, color: null };

  const reviewColor = settings.review.enabled
    ? resolveReviewColor(wp.reviewStatusId, settings.review)
    : null;

  return {
    workPackage: wp,
    priorityPosition: position,
    priorityColor: color,
    departmentLabel: settings.department.enabled
      ? formatDepartmentLabel(wp.department, settings.department)
      : "",
    reviewColor,
    reviewStatusLabel: reviewColor ? wp.reviewStatusLabel : "",
    storyPoints: settings.storyPoints.enabled ? wp.storyPoints : null,
    ciSummary: null,
    blockersOk: null,
    columnTimeText: null,
    reworkReturns: null,
  };
}

async function patchWorkPackage(
  id: number,
  patch: WorkPackagePatch,
): Promise<CardEnrichment> {
  const settings = await loadSettings();
  const client = clientFromSettings(settings);
  const updated = await updateWorkPackage(client, id, patch, {
    departmentField: settings.department.field,
    storyPointsField: settings.storyPoints.field,
    reviewField: settings.review.field,
  });
  putWorkPackage(updated);
  const priorities = settings.priority.enabled
    ? await getPriorities(client)
    : ([] as PriorityInfo[]);
  return buildFastEnrichment(updated, settings, priorities);
}

async function getAssigneeOptions(workPackageId: number): Promise<AssigneeOption[]> {
  const settings = await loadSettings();
  const client = clientFromSettings(settings);
  return fetchAvailableAssignees(client, workPackageId);
}

async function getRelatedIds(client: OpenProjectClient, wpId: number): Promise<number[]> {
  const cached = getCached(relationsCache, wpId);
  if (cached) return cached;

  const relations = await fetchRelations(client, wpId);
  const otherIds = [...new Set(relations.map((r) => r.otherId).filter((id) => id !== wpId))];
  setCached(relationsCache, wpId, otherIds, RELATIONS_TTL_MS);
  return otherIds;
}

async function getActivities(
  client: OpenProjectClient,
  wpId: number,
): Promise<Record<string, unknown>[]> {
  const cached = getCached(activitiesCache, wpId);
  if (cached) return cached;
  const activities = await fetchActivities(client, wpId);
  setCached(activitiesCache, wpId, activities, ACTIVITIES_TTL_MS);
  return activities;
}

async function getGithubCiSummary(
  client: OpenProjectClient,
  wpId: number,
): Promise<CiSummary | null> {
  const entry = githubCiCache.get(wpId);
  if (entry && Date.now() <= entry.expiresAt) {
    return entry.value;
  }

  const summary = await fetchGithubCiSummary(client, wpId);
  setCached(githubCiCache, wpId, summary, GITHUB_CI_TTL_MS);
  return summary;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Tier 1 — WP fields only (priority, SP, department). One batch API call. */
async function enrichCardsFast(ids: number[], force = false): Promise<Record<string, CardEnrichment>> {
  console.log("[op-board-ext:bg] enrich FAST start", {
    count: ids.length,
    force,
    store: workPackageStoreStats(),
  });
  const settings = await loadSettings();
  const client = clientFromSettings(settings);
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];

  if (force) {
    invalidateWorkPackages(unique);
    for (const id of unique) {
      activitiesCache.delete(id);
      relationsCache.delete(id);
      githubCiCache.delete(id);
    }
  }

  const [workPackages, priorities] = await Promise.all([
    ensureWorkPackages(client, unique, settings),
    settings.priority.enabled ? getPriorities(client) : Promise.resolve([] as PriorityInfo[]),
  ]);

  const enrichments: Record<string, CardEnrichment> = {};
  for (const id of unique) {
    const wp = workPackages.get(id);
    if (!wp) continue;
    enrichments[String(id)] = buildFastEnrichment(wp, settings, priorities);
  }

  console.log("[op-board-ext:bg] enrich FAST done", {
    count: Object.keys(enrichments).length,
    store: workPackageStoreStats(),
  });
  return enrichments;
}

/** Tier 2 — relations/blockers, activities, GitHub CI — parallel & cached. */
async function enrichCardsLazy(ids: number[]): Promise<Record<string, CardLazyEnrichment>> {
  console.log("[op-board-ext:bg] enrich LAZY start", { count: ids.length, store: workPackageStoreStats() });
  const settings = await loadSettings();
  const client = clientFromSettings(settings);
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];

  // Ensure primary WPs are in store (no-op if FAST already loaded them)
  await ensureWorkPackages(client, unique, settings);

  const needBlockers = settings.blockers.enabled;
  const needActivities = settings.columnTime.enabled || settings.reworkReturns.enabled;

  const relatedByWp = new Map<number, number[]>();
  if (needBlockers) {
    await mapLimit(unique, 4, async (id) => {
      try {
        relatedByWp.set(id, await getRelatedIds(client, id));
      } catch {
        relatedByWp.set(id, []);
      }
    });
    const allRelatedIds = [...new Set([...relatedByWp.values()].flat())];
    if (allRelatedIds.length > 0) {
      await ensureWorkPackages(client, allRelatedIds, settings);
    }
  }

  const enrichments: Record<string, CardLazyEnrichment> = {};

  await mapLimit(unique, 4, async (id) => {
    const wp = peekWorkPackage(id);
    if (!wp) return;

    const blockersPromise: Promise<boolean | null> = needBlockers
      ? (async () => {
          const relatedIds = relatedByWp.get(id) ?? [];
          if (relatedIds.length === 0) return true;
          const known = relatedIds
            .map((rid) => peekWorkPackage(rid))
            .filter((x): x is NonNullable<typeof x> => x != null);
          if (known.length < relatedIds.length) return false;
          return computeBlockersOk(known, settings.blockers);
        })()
      : Promise.resolve(null);

    const ciPromise: Promise<CiSummary | null> = (async () => {
      try {
        return await getGithubCiSummary(client, id);
      } catch {
        return null;
      }
    })();

    const activitiesPromise: Promise<{
      columnTimeText: string | null;
      reworkReturns: number | null;
    }> = needActivities
      ? (async () => {
          try {
            const activities = await getActivities(client, id);
            return {
              columnTimeText: settings.columnTime.enabled
                ? computeColumnTimeText(activities, wp.statusName, wp.createdAt)
                : null,
              reworkReturns: settings.reworkReturns.enabled
                ? countReworkReturns(activities, settings.blockers.doneStatusNames)
                : null,
            };
          } catch {
            return {
              columnTimeText: settings.columnTime.enabled ? "?" : null,
              reworkReturns: null,
            };
          }
        })()
      : Promise.resolve({ columnTimeText: null, reworkReturns: null });

    const [blockersOk, ciSummary, activityFields] = await Promise.all([
      blockersPromise,
      ciPromise,
      activitiesPromise,
    ]);

    enrichments[String(id)] = {
      blockersOk,
      ciSummary,
      columnTimeText: activityFields.columnTimeText,
      reworkReturns: activityFields.reworkReturns,
    };
  });

  console.log("[op-board-ext:bg] enrich LAZY done", {
    count: Object.keys(enrichments).length,
    store: workPackageStoreStats(),
  });
  return enrichments;
}

async function getUnreadNotifications(force = false): Promise<NotificationSummary[]> {
  if (!force && notificationsCache && Date.now() < notificationsCache.expiresAt) {
    return notificationsCache.value;
  }
  const settings = await loadSettings();
  const client = clientFromSettings(settings);
  const notifications = await fetchUnreadNotifications(client);
  notificationsCache = { value: notifications, expiresAt: Date.now() + NOTIFICATIONS_TTL_MS };
  return notifications;
}

async function markWpNotificationsRead(
  workPackageId: number,
  notificationIds: number[] = [],
): Promise<NotificationSummary[]> {
  const settings = await loadSettings();
  const client = clientFromSettings(settings);
  const cachedIds =
    notificationIds.length > 0
      ? notificationIds
      : (notificationsCache?.value ?? [])
          .filter((n) => n.workPackageId === workPackageId)
          .map((n) => n.id);

  console.log("[op-board-ext:bg] MARK_WP_NOTIFICATIONS_READ", {
    workPackageId,
    notificationIds: cachedIds,
  });

  await markWorkPackageNotificationsRead(client, workPackageId, cachedIds);

  notificationsCache = null;
  return getUnreadNotifications(true);
}

async function getWorkPackageOverviewExtras(workPackageId: number): Promise<WorkPackageOverviewExtras> {
  const settings = await loadSettings();
  const client = clientFromSettings(settings);

  const relations = await fetchRelations(client, workPackageId);
  const relatedIds = [...new Set(relations.map((relation) => relation.otherId).filter((id) => id > 0))];
  const relatedWorkPackages =
    relatedIds.length > 0
      ? await ensureWorkPackages(client, relatedIds, settings)
      : new Map();

  const relationItems: RelationOverviewItem[] = relations
    .map((relation) => {
      const wp = relatedWorkPackages.get(relation.otherId);
      if (!wp) return null;
      return {
        ...relation,
        otherSubject: wp.subject,
        otherStatusName: wp.statusName,
        otherIsClosed: wp.isClosed,
      } satisfies RelationOverviewItem;
    })
    .filter((item): item is RelationOverviewItem => item != null);

  let pullRequests: GithubPullRequestOverviewItem[] = [];
  try {
    pullRequests = await fetchGithubPullRequestOverview(client, workPackageId);
  } catch {
    pullRequests = [];
  }

  return {
    relations: relationItems,
    pullRequests,
  };
}

async function testConnection(): Promise<string> {
  const settings = await loadSettings();
  const client = clientFromSettings(settings);
  await client.getJson("/api/v3/users/me");
  return "Connection OK";
}

async function resolveBoardSprint(boardId: number): Promise<string[]> {
  const settings = await loadSettings();
  const client = clientFromSettings(settings);
  return resolveBoardSprintValues(client, boardId);
}

async function getSettingsOptions(message: Extract<BackgroundRequest, { type: "GET_SETTINGS_OPTIONS" }>) {
  return fetchPopupSettingsOptions(message.connection, message.departmentField);
}

async function getDepartmentOptions(
  message: Extract<BackgroundRequest, { type: "GET_DEPARTMENT_OPTIONS" }>,
) {
  return fetchDepartmentOptions(message.connection, message.departmentField);
}

function toErrorResponse(error: unknown): BackgroundResponse {
  if (error instanceof ApiError) {
    return { ok: false, error: error.message, code: error.code };
  }
  return {
    ok: false,
    error: error instanceof Error ? error.message : "Unknown error",
    code: "UNKNOWN",
  };
}

chrome.runtime.onMessage.addListener((message: BackgroundRequest, _sender, sendResponse) => {
  const respond = (payload: BackgroundResponse): void => {
    try {
      sendResponse(payload);
    } catch {
      // Port already closed — ignore
    }
  };

  void (async () => {
    try {
      switch (message.type) {
        case "GET_SETTINGS": {
          const settings = await loadSettings();
          respond({ ok: true, settings });
          break;
        }
        case "GET_SETTINGS_OPTIONS": {
          const options = await getSettingsOptions(message);
          respond({ ok: true, options });
          break;
        }
        case "GET_DEPARTMENT_OPTIONS": {
          const departmentOptions = await getDepartmentOptions(message);
          respond({ ok: true, departmentOptions });
          break;
        }
        case "SAVE_SETTINGS": {
          await saveSettings(message.settings);
          clearAllCaches();
          respond({ ok: true, settings: message.settings });
          break;
        }
        case "ENRICH_CARDS": {
          const enrichments = await enrichCardsFast(message.ids, Boolean(message.force));
          respond({ ok: true, enrichments });
          break;
        }
        case "ENRICH_CARDS_LAZY": {
          const lazyEnrichments = await enrichCardsLazy(message.ids);
          respond({ ok: true, lazyEnrichments });
          break;
        }
        case "GET_WORK_PACKAGE_OVERVIEW_EXTRAS": {
          const overviewExtras = await getWorkPackageOverviewExtras(message.id);
          respond({ ok: true, overviewExtras });
          break;
        }
        case "GET_UNREAD_NOTIFICATIONS": {
          const notifications = await getUnreadNotifications(true);
          respond({ ok: true, notifications });
          break;
        }
        case "MARK_WP_NOTIFICATIONS_READ": {
          const notifications = await markWpNotificationsRead(
            message.workPackageId,
            message.notificationIds ?? [],
          );
          respond({ ok: true, notifications });
          break;
        }
        case "GET_PRIORITIES": {
          const settings = await loadSettings();
          const client = clientFromSettings(settings);
          const priorities = await getPriorities(client);
          respond({ ok: true, priorities });
          break;
        }
        case "GET_ASSIGNEE_OPTIONS": {
          const assignees = await getAssigneeOptions(message.workPackageId);
          respond({ ok: true, assignees });
          break;
        }
        case "UPDATE_WORK_PACKAGE": {
          const enrichment = await patchWorkPackage(message.id, message.patch);
          respond({ ok: true, enrichment });
          break;
        }
        case "RESOLVE_BOARD_SPRINT": {
          const sprintValues = await resolveBoardSprint(message.boardId);
          respond({ ok: true, sprintValues });
          break;
        }
        case "TEST_CONNECTION": {
          const msg = await testConnection();
          respond({ ok: true, message: msg });
          break;
        }
        case "CLEAR_CACHE": {
          clearAllCaches();
          respond({ ok: true, message: "Cache cleared" });
          break;
        }
        default:
          respond({ ok: false, error: "Unknown message type", code: "UNKNOWN" });
      }
    } catch (error) {
      respond(toErrorResponse(error));
    }
  })();

  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[STORAGE_KEY]) {
    clearAllCaches();
  }
});
