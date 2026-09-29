import type { ReviewStatusColor, ReviewWidgetSettings } from "../types";

/**
 * Map a review custom-field value (option ID, href tail, or raw string) to a badge color.
 * IDs are configured in settings; defaults match the project (6=green, 7=yellow, 8=red).
 */
export function resolveReviewColor(
  statusId: string | null,
  settings: ReviewWidgetSettings,
): ReviewStatusColor | null {
  if (!statusId) return null;
  const value = statusId.trim();
  if (!value) return null;

  const normalized = normalizeOptionId(value);
  const pairs: Array<[string, ReviewStatusColor]> = [
    [settings.greenId, "green"],
    [settings.yellowId, "yellow"],
    [settings.redId, "red"],
  ];

  for (const [configured, color] of pairs) {
    const id = normalizeOptionId(configured);
    if (id && id === normalized) return color;
  }

  return null;
}

/** Extract a bare numeric/string option id from a value or href tail. */
export function normalizeOptionId(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  const tail = value.replace(/\/+$/, "").split("/").pop() ?? value;
  return tail.trim().toLowerCase();
}

export const REVIEW_COLOR_LABELS: Record<ReviewStatusColor, string> = {
  green: "зелёный",
  yellow: "жёлтый",
  red: "красный",
};
