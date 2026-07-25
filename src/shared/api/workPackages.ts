import type { OpenProjectClient } from "./client";
import { isRecord, linkHref, linkId, linkTitle } from "./client";
import type { AssigneeOption, WorkPackagePatch, WorkPackageSummary } from "../types";

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

function extractAssigneeAvatar(wp: Record<string, unknown>, assigneeId: number | null): string | null {
  const embedded = wp._embedded;
  if (isRecord(embedded) && isRecord(embedded.assignee)) {
    const avatar = embedded.assignee.avatar;
    if (typeof avatar === "string" && avatar.trim()) return avatar.trim();
  }
  // OpenProject serves session-authenticated avatars at /users/:id/avatar
  if (assigneeId != null) return `/users/${assigneeId}/avatar`;
  return null;
}

export function mapWorkPackage(
  wp: Record<string, unknown>,
  opts: { departmentField: string; storyPointsField: string },
): WorkPackageSummary {
  const id = Number(wp.id);
  const assigneeId = linkId(wp, "assignee");
  return {
    id,
    subject: typeof wp.subject === "string" ? wp.subject : `#${id}`,
    statusName: linkTitle(wp, "status") || "—",
    statusId: linkId(wp, "status"),
    isClosed: Boolean(wp.isClosed),
    priorityName: linkTitle(wp, "priority") || "—",
    priorityId: linkId(wp, "priority"),
    projectName: linkTitle(wp, "project") || "",
    projectId: linkId(wp, "project"),
    projectIdentifier: "",
    department: extractDepartment(wp, opts.departmentField),
    storyPoints: coerceStoryPoints(wp, opts.storyPointsField),
    assigneeId,
    assigneeName: linkTitle(wp, "assignee") || "",
    assigneeHref: linkHref(wp, "assignee") || null,
    assigneeAvatarUrl: extractAssigneeAvatar(wp, assigneeId),
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

export async function updateWorkPackage(
  client: OpenProjectClient,
  id: number,
  patch: WorkPackagePatch,
  opts: { departmentField: string; storyPointsField: string },
): Promise<WorkPackageSummary> {
  if (patch.lockVersion == null || !Number.isFinite(patch.lockVersion)) {
    throw new Error("lockVersion is required to update a work package");
  }

  const body: Record<string, unknown> = {
    lockVersion: patch.lockVersion,
  };

  if ("storyPoints" in patch) {
    body[opts.storyPointsField] = patch.storyPoints;
  }

  const links: Record<string, { href: string | null }> = {};
  if ("priorityId" in patch) {
    links.priority =
      patch.priorityId == null
        ? { href: null }
        : { href: `/api/v3/priorities/${patch.priorityId}` };
  }
  if ("assigneeHref" in patch) {
    links.assignee = { href: patch.assigneeHref ?? null };
  }
  if (Object.keys(links).length > 0) {
    body._links = links;
  }

  console.log("[op-board-ext:api] PATCH work package", { id, body });
  const wp = await client.patchJson<Record<string, unknown>>(`/api/v3/work_packages/${id}`, body);
  if (!wp) {
    throw new Error("Empty response from work package update");
  }
  return mapWorkPackage(wp, opts);
}

export async function fetchAvailableAssignees(
  client: OpenProjectClient,
  workPackageId: number,
): Promise<AssigneeOption[]> {
  const elements = await client.getCollection<Record<string, unknown>>(
    `/api/v3/work_packages/${workPackageId}/available_assignees`,
  );

  return elements
    .map((item) => {
      const id = Number(item.id);
      const name =
        (typeof item.name === "string" && item.name) ||
        [item.firstName, item.lastName].filter((p) => typeof p === "string").join(" ").trim() ||
        (typeof item.login === "string" ? item.login : "") ||
        `#${id}`;
      const self = isRecord(item._links) && isRecord(item._links.self) ? item._links.self : null;
      const href =
        (self && typeof self.href === "string" && self.href) ||
        (Number.isFinite(id) ? `/api/v3/users/${id}` : "");
      const avatarFromApi = typeof item.avatar === "string" && item.avatar.trim() ? item.avatar.trim() : null;
      const avatarUrl = avatarFromApi || (Number.isFinite(id) ? `/users/${id}/avatar` : null);
      return { id, name, href, avatarUrl };
    })
    .filter((a) => Number.isFinite(a.id) && Boolean(a.href))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
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
