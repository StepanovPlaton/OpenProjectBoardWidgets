import type { OpenProjectClient } from "./client";
import { isRecord } from "./client";

const STATUS_CHANGED_RE =
  /^(?:Статус|Status)\s+(?:изменён|изменено|changed)\s+(?:с|from)\s+(.+?)\s+(?:на|to)\s+(.+)$/i;
const STATUS_SET_RE = /^(?:Статус|Status)\s+(?:установлен(?:о)?|set)\s+(?:на|to)\s+(.+)$/i;
const STATUS_ASSIGNED_RE = /^(?:Статус|Status)\s+присвоено\s+значение\s+(.+)$/i;

export function normalizeStatusName(name: string): string {
  return name.trim().toLowerCase().split(/\s+/).join(" ");
}

export function parseStatusTransition(raw: string): { from: string | null; to: string | null } {
  const text = raw.trim();
  if (!text) return { from: null, to: null };

  let match = text.match(STATUS_CHANGED_RE);
  if (match) return { from: match[1].trim(), to: match[2].trim() };

  match = text.match(STATUS_SET_RE);
  if (match) return { from: null, to: match[1].trim() };

  match = text.match(STATUS_ASSIGNED_RE);
  if (match) return { from: null, to: match[1].trim() };

  return { from: null, to: null };
}

export function parseActivityTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const text = value.replace("Z", "+00:00");
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function findLastTransitionToStatusAt(
  activities: Record<string, unknown>[],
  targetStatusName: string,
): Date | null {
  const target = normalizeStatusName(targetStatusName);
  let lastAt: Date | null = null;

  const sorted = [...activities].sort((a, b) => {
    const ta = parseActivityTimestamp(a.createdAt)?.getTime() ?? 0;
    const tb = parseActivityTimestamp(b.createdAt)?.getTime() ?? 0;
    if (ta !== tb) return ta - tb;
    return (Number(a.version) || 0) - (Number(b.version) || 0);
  });

  for (const activity of sorted) {
    const createdAt = parseActivityTimestamp(activity.createdAt);
    if (!createdAt) continue;
    const details = activity.details;
    if (!Array.isArray(details)) continue;

    for (const detail of details) {
      if (!isRecord(detail) || typeof detail.raw !== "string") continue;
      const { to } = parseStatusTransition(detail.raw);
      if (to && normalizeStatusName(to) === target) {
        lastAt = createdAt;
      }
    }
  }

  return lastAt;
}

export async function fetchActivities(
  client: OpenProjectClient,
  workPackageId: number,
): Promise<Record<string, unknown>[]> {
  return client.getCollection<Record<string, unknown>>(
    `/api/v3/work_packages/${workPackageId}/activities`,
  );
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s <= 0) return "0м";

  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);

  if (days > 0) return `${days}д`;
  if (hours > 0) return `${hours}ч`;
  if (minutes > 0) return `${minutes}м`;
  return `${s}с`;
}

export function computeColumnTimeText(
  activities: Record<string, unknown>[],
  statusName: string,
  createdAt: string | null,
): string {
  let enteredAt = findLastTransitionToStatusAt(activities, statusName);
  if (!enteredAt && createdAt) {
    enteredAt = parseActivityTimestamp(createdAt);
  }
  if (!enteredAt) return "?";

  const deltaSec = Math.max(0, (Date.now() - enteredAt.getTime()) / 1000);
  return formatDuration(deltaSec);
}
