import { isRecord } from "../api/client";
import {
  normalizeStatusName,
  parseActivityTimestamp,
  parseStatusTransition,
} from "../api/activities";

function isDoneStatusName(name: string, doneStatusNames: string[]): boolean {
  const current = normalizeStatusName(name);
  return doneStatusNames.some((done) => normalizeStatusName(done) === current);
}

/**
 * Count transitions from a "done" status back to a non-done status
 * (returns to rework), based on activity history text.
 */
export function countReworkReturns(
  activities: Record<string, unknown>[],
  doneStatusNames: string[],
): number {
  if (doneStatusNames.length === 0) return 0;

  const sorted = [...activities].sort((a, b) => {
    const ta = parseActivityTimestamp(a.createdAt)?.getTime() ?? 0;
    const tb = parseActivityTimestamp(b.createdAt)?.getTime() ?? 0;
    if (ta !== tb) return ta - tb;
    return (Number(a.version) || 0) - (Number(b.version) || 0);
  });

  let count = 0;
  for (const activity of sorted) {
    const details = activity.details;
    if (!Array.isArray(details)) continue;

    for (const detail of details) {
      if (!isRecord(detail) || typeof detail.raw !== "string") continue;
      const { from, to } = parseStatusTransition(detail.raw);
      if (!from || !to) continue;
      if (isDoneStatusName(from, doneStatusNames) && !isDoneStatusName(to, doneStatusNames)) {
        count += 1;
      }
    }
  }

  return count;
}

export type ReworkSeverity = "warn" | "orange" | "danger";

export function reworkSeverity(count: number): ReworkSeverity {
  if (count >= 3) return "danger";
  if (count === 2) return "orange";
  return "warn";
}
