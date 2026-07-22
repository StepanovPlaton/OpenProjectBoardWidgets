import { ApiError, OpenProjectClient } from "../shared/api/client";
import { fetchActivities, computeColumnTimeText } from "../shared/api/activities";
import {
  fetchGithubCiSummary,
  fetchGithubPullRequestOverview,
} from "../shared/api/githubPullRequests";
import { resolveBoardSprintValues } from "../shared/api/boardSprint";
import { buildBoardSnapshotHash } from "../shared/api/boardSnapshot";
import { fetchPriorities } from "../shared/api/priorities";
import { fetchRelations } from "../shared/api/relations";
import { fetchPopupSettingsOptions } from "../shared/api/settingsOptions";
import { fetchWorkPackagesByIds } from "../shared/api/workPackages";
import { STORAGE_KEY, loadSettings, normalizeBaseUrl, saveSettings } from "../shared/settings";
import type {
  BackgroundRequest,
  BackgroundResponse,
  CardEnrichment,
  CiSummary,
  GithubPullRequestOverviewItem,
  PriorityInfo,
  RelationOverviewItem,
  Settings,
  WorkPackageSummary,
  WorkPackageOverviewExtras,
} from "../shared/types";
import { computeBlockersOk } from "../shared/widgets/blockers";
import { formatDepartmentLabel } from "../shared/widgets/department";
import { resolvePriorityDisplay } from "../shared/widgets/priority";

const WP_TTL_MS = 60_000;
const PRIORITY_TTL_MS = 10 * 60_000;
const RELATIONS_TTL_MS = 90_000;
const ACTIVITIES_TTL_MS = 120_000;
const GITHUB_CI_TTL_MS = 60_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const wpCache = new Map<number, CacheEntry<WorkPackageSummary>>();
const relationsCache = new Map<number, CacheEntry<number[]>>();
const activitiesCache = new Map<number, CacheEntry<Record<string, unknown>[]>>();
const githubCiCache = new Map<number, CacheEntry<CiSummary | null>>();
let prioritiesCache: CacheEntry<PriorityInfo[]> | null = null;

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
  wpCache.clear();
  relationsCache.clear();
  activitiesCache.clear();
  githubCiCache.clear();
  prioritiesCache = null;
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

async function ensureWorkPackages(
  client: OpenProjectClient,
  ids: number[],
  settings: Settings,
): Promise<Map<number, WorkPackageSummary>> {
  const missing: number[] = [];
  const result = new Map<number, WorkPackageSummary>();

  for (const id of ids) {
    const cached = getCached(wpCache, id);
    if (cached) result.set(id, cached);
    else missing.push(id);
  }

  if (missing.length > 0) {
    const fetched = await fetchWorkPackagesByIds(client, missing, {
      departmentField: settings.department.field,
      storyPointsField: settings.storyPoints.field,
    });
    for (const [id, wp] of fetched) {
      setCached(wpCache, id, wp, WP_TTL_MS);
      result.set(id, wp);
    }
  }

  return result;
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
  const cached = getCached(githubCiCache, wpId);
  if (cached || githubCiCache.has(wpId)) return cached;

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

async function enrichCards(ids: number[]): Promise<Record<string, CardEnrichment>> {
  console.log("[op-board-ext:bg] enrichCards start", { count: ids.length, ids });
  const settings = await loadSettings();
  const client = clientFromSettings(settings);
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];

  const workPackages = await ensureWorkPackages(client, unique, settings);
  console.log("[op-board-ext:bg] work packages fetched", {
    requested: unique.length,
    got: workPackages.size,
  });
  const priorities = settings.priority.enabled ? await getPriorities(client) : [];

  // Collect related IDs if blockers enabled
  const relatedByWp = new Map<number, number[]>();
  if (settings.blockers.enabled) {
    await mapLimit(unique, 2, async (id) => {
      try {
        relatedByWp.set(id, await getRelatedIds(client, id));
      } catch {
        relatedByWp.set(id, []);
      }
    });
  }

  const allRelatedIds = [...new Set([...relatedByWp.values()].flat())];
  if (allRelatedIds.length > 0) {
    await ensureWorkPackages(client, allRelatedIds, settings);
  }

  const enrichments: Record<string, CardEnrichment> = {};

  await mapLimit(unique, 2, async (id) => {
    const wp = workPackages.get(id);
    if (!wp) return;

    const { position, color } = settings.priority.enabled
      ? resolvePriorityDisplay(wp.priorityId, wp.priorityName, priorities)
      : { position: null, color: null };

    const departmentLabel = settings.department.enabled
      ? formatDepartmentLabel(wp.department, settings.department)
      : "";

    let blockersOk: boolean | null = null;
    if (settings.blockers.enabled) {
      const relatedIds = relatedByWp.get(id) ?? [];
      const known = relatedIds
        .map((rid) => getCached(wpCache, rid))
        .filter((x): x is WorkPackageSummary => x != null);
      if (relatedIds.length === 0) {
        blockersOk = true;
      } else if (known.length < relatedIds.length) {
        // Incomplete fetch: treat missing related WPs as not done
        blockersOk = false;
      } else {
        blockersOk = computeBlockersOk(known, settings.blockers);
      }
    }

    let ciSummary: CiSummary | null = null;
    try {
      ciSummary = await getGithubCiSummary(client, id);
    } catch {
      ciSummary = null;
    }

    let columnTimeText: string | null = null;
    if (settings.columnTime.enabled) {
      try {
        const activities = await getActivities(client, id);
        columnTimeText = computeColumnTimeText(
          activities,
          wp.statusName,
          wp.createdAt,
          settings.columnTime.format,
        );
      } catch {
        columnTimeText = "?";
      }
    }

    enrichments[String(id)] = {
      workPackage: wp,
      priorityPosition: position,
      priorityColor: color,
      departmentLabel,
      storyPoints: settings.storyPoints.enabled ? wp.storyPoints : null,
      ciSummary,
      blockersOk,
      columnTimeText,
    };
  });

  console.log("[op-board-ext:bg] enrichCards done", {
    count: Object.keys(enrichments).length,
  });
  return enrichments;
}

async function boardSnapshot(ids: number[]): Promise<{ snapshotHash: string; ids: number[] }> {
  const settings = await loadSettings();
  const client = clientFromSettings(settings);
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];

  // Always hit API (no cache) so staleness detection is accurate
  const workPackages = await fetchWorkPackagesByIds(client, unique, {
    departmentField: settings.department.field,
    storyPointsField: settings.storyPoints.field,
  });

  const items = unique.map((id) => {
    const wp = workPackages.get(id);
    return {
      id,
      updatedAt: wp?.updatedAt ?? null,
      lockVersion: wp?.lockVersion ?? null,
      statusId: wp?.statusId ?? null,
      statusName: wp?.statusName ?? "",
    };
  });
  return {
    snapshotHash: buildBoardSnapshotHash(items),
    ids: unique,
  };
}

async function getWorkPackageOverviewExtras(workPackageId: number): Promise<WorkPackageOverviewExtras> {
  const settings = await loadSettings();
  const client = clientFromSettings(settings);

  const relations = await fetchRelations(client, workPackageId);
  const relatedIds = [...new Set(relations.map((relation) => relation.otherId).filter((id) => id > 0))];
  const relatedWorkPackages =
    relatedIds.length > 0 ? await ensureWorkPackages(client, relatedIds, settings) : new Map<number, WorkPackageSummary>();

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
        case "SAVE_SETTINGS": {
          await saveSettings(message.settings);
          clearAllCaches();
          respond({ ok: true, settings: message.settings });
          break;
        }
        case "ENRICH_CARDS": {
          const enrichments = await enrichCards(message.ids);
          respond({ ok: true, enrichments });
          break;
        }
        case "GET_WORK_PACKAGE_OVERVIEW_EXTRAS": {
          const overviewExtras = await getWorkPackageOverviewExtras(message.id);
          respond({ ok: true, overviewExtras });
          break;
        }
        case "BOARD_SNAPSHOT": {
          const snapshot = await boardSnapshot(message.ids);
          respond({ ok: true, ...snapshot });
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

  // Keep the message channel open for the async response
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[STORAGE_KEY]) {
    clearAllCaches();
  }
});
