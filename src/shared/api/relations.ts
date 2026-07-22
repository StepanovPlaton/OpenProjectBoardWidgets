import type { OpenProjectClient } from "./client";
import { isRecord, linkId } from "./client";
import type { RelationSummary } from "../types";

export async function fetchRelations(
  client: OpenProjectClient,
  workPackageId: number,
): Promise<RelationSummary[]> {
  const elements = await client.getCollection<Record<string, unknown>>(
    `/api/v3/work_packages/${workPackageId}/relations`,
  );

  const relations: RelationSummary[] = [];
  for (const item of elements) {
    const id = Number(item.id);
    const type = typeof item.type === "string" ? item.type : "relates";
    const fromId = linkId(item, "from");
    const toId = linkId(item, "to");
    if (!Number.isFinite(id) || fromId == null || toId == null) continue;

    const otherId = fromId === workPackageId ? toId : fromId;
    relations.push({ id, type, fromId, toId, otherId });
  }
  return relations;
}

/** Also try HAL _links.relations collection href if present on WP */
export async function fetchRelationsFromWp(
  client: OpenProjectClient,
  workPackageId: number,
  wp?: Record<string, unknown>,
): Promise<RelationSummary[]> {
  if (wp && isRecord(wp._links) && isRecord(wp._links.relations)) {
    const href = wp._links.relations.href;
    if (typeof href === "string" && href) {
      try {
        const page = await client.getJson<{ _embedded?: { elements?: Record<string, unknown>[] } }>(href);
        const elements = page._embedded?.elements ?? [];
        return elements
          .map((item) => {
            const id = Number(item.id);
            const type = typeof item.type === "string" ? item.type : "relates";
            const fromId = linkId(item, "from");
            const toId = linkId(item, "to");
            if (!Number.isFinite(id) || fromId == null || toId == null) return null;
            const otherId = fromId === workPackageId ? toId : fromId;
            return { id, type, fromId, toId, otherId } satisfies RelationSummary;
          })
          .filter((x): x is RelationSummary => x != null);
      } catch {
        // fall through
      }
    }
  }
  return fetchRelations(client, workPackageId);
}
