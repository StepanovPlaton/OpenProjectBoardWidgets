import type { OpenProjectClient } from "../shared/api/client";
import { fetchWorkPackagesByIds } from "../shared/api/workPackages";
import type { PopupSelectOption, Settings, WorkPackageSummary } from "../shared/types";

const WP_TTL_MS = 5 * 60_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Shared work-package store: TTL cache + in-flight dedupe across enrich tiers. */
const wpCache = new Map<number, CacheEntry<WorkPackageSummary>>();
/** In-flight fetches keyed by id — concurrent callers await the same promise. */
const wpInflight = new Map<number, Promise<WorkPackageSummary | null>>();

function getCached(id: number): WorkPackageSummary | null {
  const entry = wpCache.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    wpCache.delete(id);
    return null;
  }
  return entry.value;
}

function setCached(id: number, value: WorkPackageSummary): void {
  wpCache.set(id, { value, expiresAt: Date.now() + WP_TTL_MS });
}

export function peekWorkPackage(id: number): WorkPackageSummary | null {
  return getCached(id);
}

export function clearWorkPackageStore(): void {
  wpCache.clear();
  wpInflight.clear();
}

export function invalidateWorkPackages(ids: number[]): void {
  for (const id of ids) {
    wpCache.delete(id);
    wpInflight.delete(id);
  }
}

export function putWorkPackage(wp: WorkPackageSummary): void {
  setCached(wp.id, wp);
}

export function workPackageStoreStats(): { cached: number; inflight: number } {
  return { cached: wpCache.size, inflight: wpInflight.size };
}

/**
 * Department options collected from work packages already in the store (e.g. board cards).
 * Last-resort fallback when the field's allowed values cannot be resolved via the API.
 */
export function collectCachedDepartmentOptions(): PopupSelectOption[] {
  const byLabel = new Map<string, PopupSelectOption>();
  for (const entry of wpCache.values()) {
    const { department, departmentHref, departmentOptionId } = entry.value;
    if (!department.trim()) continue;
    if (byLabel.has(department)) continue;
    const value = departmentOptionId || department;
    byLabel.set(
      department,
      departmentHref ? { value, label: department, href: departmentHref } : { value, label: department },
    );
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label, "ru"));
}

/**
 * Ensure WPs are in the shared store. Already-cached / in-flight ids are not re-fetched.
 */
export async function ensureWorkPackages(
  client: OpenProjectClient,
  ids: number[],
  settings: Settings,
): Promise<Map<number, WorkPackageSummary>> {
  const result = new Map<number, WorkPackageSummary>();
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];
  const toFetch: number[] = [];
  const waiters: Promise<void>[] = [];

  for (const id of unique) {
    const cached = getCached(id);
    if (cached) {
      result.set(id, cached);
      continue;
    }

    const inflight = wpInflight.get(id);
    if (inflight) {
      waiters.push(
        inflight.then((wp) => {
          if (wp) result.set(id, wp);
        }),
      );
      continue;
    }

    toFetch.push(id);
  }

  if (toFetch.length > 0) {
    console.log("[op-board-ext:store] WP fetch", {
      requested: unique.length,
      cacheHits: unique.length - toFetch.length - waiters.length,
      waitingInflight: waiters.length,
      fetching: toFetch.length,
    });

    const fetchPromise = fetchWorkPackagesByIds(client, toFetch, {
      departmentField: settings.department.field,
      storyPointsField: settings.storyPoints.field,
      reviewField: settings.review.field,
    })
      .then((fetched) => {
        for (const [id, wp] of fetched) {
          setCached(id, wp);
        }
        return fetched;
      })
      .finally(() => {
        for (const id of toFetch) {
          wpInflight.delete(id);
        }
      });

    for (const id of toFetch) {
      wpInflight.set(
        id,
        fetchPromise.then((fetched) => fetched.get(id) ?? getCached(id)),
      );
    }

    const fetched = await fetchPromise;
    for (const [id, wp] of fetched) {
      result.set(id, wp);
    }
  }

  if (waiters.length > 0) {
    await Promise.all(waiters);
  }

  return result;
}
