import { normalizeStatusName } from "../api/activities";
import type { BlockersWidgetSettings, WorkPackageSummary } from "../types";

export function isStatusDone(
  wp: WorkPackageSummary,
  settings: BlockersWidgetSettings,
): boolean {
  if (settings.treatClosedAsDone && wp.isClosed) return true;
  const current = normalizeStatusName(wp.statusName);
  return settings.doneStatusNames.some((name) => normalizeStatusName(name) === current);
}

/**
 * All relations: OK (checkmark) when every related WP is done, or there are no relations.
 */
export function computeBlockersOk(
  relatedPackages: WorkPackageSummary[],
  settings: BlockersWidgetSettings,
): boolean {
  if (relatedPackages.length === 0) return true;
  return relatedPackages.every((wp) => isStatusDone(wp, settings));
}
