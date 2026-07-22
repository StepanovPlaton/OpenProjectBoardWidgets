/** Build a stable board fingerprint from WP ids + timestamps/status (one batch fetch). */
export function buildBoardSnapshotHash(
  items: Array<{
    id: number;
    updatedAt: string | null;
    lockVersion: number | null;
    statusId: number | null;
    statusName: string;
  }>,
): string {
  const parts = items
    .map(
      (item) =>
        `${item.id}:${item.lockVersion ?? ""}:${item.updatedAt ?? ""}:${item.statusId ?? item.statusName}`,
    )
    .sort();
  return simpleHash(parts.join("|"));
}

function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
