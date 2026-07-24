import type { OpenProjectClient } from "./client";
import { isRecord, linkHref, linkId, linkTitle } from "./client";
import type { NotificationSummary } from "../types";

const WP_HREF_RE = /\/work_packages\/(\d+)(?:\/|$|\?|#)/i;

function filtersQuery(filters: unknown[]): string {
  return `filters=${encodeURIComponent(JSON.stringify(filters))}`;
}

function workPackageIdFromNotification(item: Record<string, unknown>): number | null {
  const embedded = isRecord(item._embedded) ? item._embedded : null;
  const resource = embedded && isRecord(embedded.resource) ? embedded.resource : null;
  if (resource) {
    if (resource._type === "WorkPackage" || String(resource._type ?? "").includes("WorkPackage")) {
      const id = Number(resource.id);
      if (Number.isFinite(id) && id > 0) return id;
    }
  }

  const href = linkHref(item, "resource");
  if (href) {
    const match = href.match(WP_HREF_RE);
    if (match) {
      const id = Number(match[1]);
      if (Number.isFinite(id) && id > 0) return id;
    }
    // /api/v3/work_packages/123
    if (/\/work_packages\//i.test(href)) {
      const id = linkId(item, "resource");
      if (id != null && id > 0) return id;
    }
  }
  return null;
}

function workPackageSubjectFromNotification(item: Record<string, unknown>): string {
  const embedded = isRecord(item._embedded) ? item._embedded : null;
  const resource = embedded && isRecord(embedded.resource) ? embedded.resource : null;
  if (resource && typeof resource.subject === "string" && resource.subject) {
    return resource.subject;
  }
  return linkTitle(item, "resource") || "";
}

function projectNameFromNotification(item: Record<string, unknown>): string {
  const embedded = isRecord(item._embedded) ? item._embedded : null;
  const project = embedded && isRecord(embedded.project) ? embedded.project : null;
  if (project && typeof project.name === "string" && project.name) {
    return project.name;
  }
  return linkTitle(item, "project") || "";
}

function actorNameFromNotification(item: Record<string, unknown>): string {
  const embedded = isRecord(item._embedded) ? item._embedded : null;
  const actor =
    (embedded && isRecord(embedded.actor) ? embedded.actor : null) ||
    (embedded && isRecord(embedded.author) ? embedded.author : null);
  if (actor && typeof actor.name === "string" && actor.name) {
    return actor.name;
  }
  return linkTitle(item, "actor") || linkTitle(item, "author") || "";
}

export function mapNotification(item: Record<string, unknown>): NotificationSummary | null {
  const id = Number(item.id);
  if (!Number.isFinite(id) || id <= 0) return null;

  const reason = typeof item.reason === "string" ? item.reason : "subscribed";
  const readIAN = Boolean(item.readIAN);
  const createdAt = typeof item.createdAt === "string" ? item.createdAt : null;
  const subject = typeof item.subject === "string" ? item.subject : "";

  return {
    id,
    reason,
    readIAN,
    subject,
    workPackageId: workPackageIdFromNotification(item),
    workPackageSubject: workPackageSubjectFromNotification(item),
    projectName: projectNameFromNotification(item),
    actorName: actorNameFromNotification(item),
    createdAt,
  };
}

/** Unread in-app notifications for the current user. */
export async function fetchUnreadNotifications(
  client: OpenProjectClient,
): Promise<NotificationSummary[]> {
  const filters = [{ readIAN: { operator: "=", values: ["f"] } }];
  const elements = await client.getCollection<Record<string, unknown>>(
    `/api/v3/notifications?${filtersQuery(filters)}`,
  );
  return elements.map(mapNotification).filter((n): n is NotificationSummary => n != null);
}

/** Mark a single notification as read (in-app). */
export async function markNotificationRead(
  client: OpenProjectClient,
  notificationId: number,
): Promise<void> {
  const path = `/api/v3/notifications/${notificationId}/read_ian`;
  console.log("[op-board-ext:api] POST mark notification read", { path, notificationId });
  await client.postJson(path);
}

/**
 * Mark unread notifications for a work package as read.
 * Per docs: POST /api/v3/notifications/read_ian?filters=... (supports id / resourceId filters)
 * and POST /api/v3/notifications/{id}/read_ian
 * @see https://www.openproject.org/docs/api/endpoints/notifications/
 */
export async function markWorkPackageNotificationsRead(
  client: OpenProjectClient,
  workPackageId: number,
  notificationIds: number[] = [],
): Promise<void> {
  const ids = [...new Set(notificationIds.filter((id) => Number.isFinite(id) && id > 0))].map(String);

  if (ids.length > 0) {
    // Bulk by id — documented filter on read_ian collection
    const filters = [{ id: { operator: "=", values: ids } }];
    const path = `/api/v3/notifications/read_ian?${filtersQuery(filters)}`;
    console.log("[op-board-ext:api] POST mark notifications read (bulk by id)", {
      path,
      workPackageId,
      ids,
    });
    try {
      await client.postJson(path);
      return;
    } catch (error) {
      console.warn("[op-board-ext:api] bulk read_ian by id failed, falling back to per-id", error);
    }

    for (const id of ids) {
      await markNotificationRead(client, Number(id));
    }
    return;
  }

  const filters = [
    { resourceId: { operator: "=", values: [String(workPackageId)] } },
    { resourceType: { operator: "=", values: ["WorkPackage"] } },
  ];
  const path = `/api/v3/notifications/read_ian?${filtersQuery(filters)}`;
  console.log("[op-board-ext:api] POST mark notifications read (by resource)", {
    path,
    workPackageId,
  });
  await client.postJson(path);
}

export function notificationReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    mentioned: "Вас упомянули",
    assigned: "Вас назначили",
    commented: "Новый комментарий",
    created: "Создана задача",
    dateAlert: "Напоминание о дате",
    prioritized: "Изменён приоритет",
    processed: "Изменён статус",
    responsible: "Назначен ответственный",
    subscribed: "Подписка",
    scheduled: "Изменено расписание",
    watched: "Наблюдение",
  };
  return labels[reason] || "Уведомление";
}
