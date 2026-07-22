import type { OpenProjectClient } from "./client";
import { isRecord, linkId, linkTitle } from "./client";
import type { WorkPackageSummary } from "../types";

function coerceStoryPoints(wp: Record<string, unknown>, field: string): number | null {
  const value = wp[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractDepartment(wp: Record<string, unknown>, field: string): string {
  const links = wp._links;
  if (isRecord(links) && isRecord(links[field]) && typeof links[field].title === "string") {
    return links[field].title;
  }
  const raw = wp[field];
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  return "";
}

export function mapWorkPackage(
  wp: Record<string, unknown>,
  opts: { departmentField: string; storyPointsField: string },
): WorkPackageSummary {
  const id = Number(wp.id);
  return {
    id,
    subject: typeof wp.subject === "string" ? wp.subject : `#${id}`,
    statusName: linkTitle(wp, "status") || "—",
    statusId: linkId(wp, "status"),
    isClosed: Boolean(wp.isClosed),
    priorityName: linkTitle(wp, "priority") || "—",
    priorityId: linkId(wp, "priority"),
    projectName: linkTitle(wp, "project") || "",
    projectIdentifier: "",
    department: extractDepartment(wp, opts.departmentField),
    storyPoints: coerceStoryPoints(wp, opts.storyPointsField),
    createdAt: typeof wp.createdAt === "string" ? wp.createdAt : null,
    updatedAt: typeof wp.updatedAt === "string" ? wp.updatedAt : null,
    lockVersion: typeof wp.lockVersion === "number" ? wp.lockVersion : null,
  };
}

export async function fetchWorkPackagesByIds(
  client: OpenProjectClient,
  ids: number[],
  opts: { departmentField: string; storyPointsField: string },
): Promise<Map<number, WorkPackageSummary>> {
  const result = new Map<number, WorkPackageSummary>();
  if (ids.length === 0) return result;

  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];
  const chunkSize = 100;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const filters = JSON.stringify([{ id: { operator: "=", values: chunk.map(String) } }]);
    const path = `/api/v3/work_packages?filters=${encodeURIComponent(filters)}`;
    const elements = await client.getCollection<Record<string, unknown>>(path);
    for (const wp of elements) {
      const mapped = mapWorkPackage(wp, opts);
      if (Number.isFinite(mapped.id)) {
        result.set(mapped.id, mapped);
      }
    }
  }

  const missing = unique.filter((id) => !result.has(id));
  await mapLimit(missing, 5, async (id) => {
    try {
      const wp = await client.getJson<Record<string, unknown>>(`/api/v3/work_packages/${id}`);
      result.set(id, mapWorkPackage(wp, opts));
    } catch {
      // ignore single failures
    }
  });

  return result;
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
