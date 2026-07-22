import { linkHref, isRecord, type OpenProjectClient } from "./client";

interface GridWidget {
  options?: Record<string, unknown>;
}

interface GridResponse {
  widgets?: GridWidget[];
}

interface QueryFilterInstance {
  name?: string;
  values?: unknown[];
  _links?: Record<string, unknown>;
}

interface QueryResponse {
  filters?: QueryFilterInstance[];
}

function filterId(filter: QueryFilterInstance): string {
  if (typeof filter.name === "string" && filter.name) return filter.name;
  const href = linkHref(filter as Record<string, unknown>, "filter");
  if (!href) return "";
  return href.replace(/\/+$/, "").split("/").pop() ?? "";
}

function filterValues(filter: QueryFilterInstance): string[] {
  if (Array.isArray(filter.values) && filter.values.length > 0) {
    return filter.values
      .map((value) => {
        if (typeof value === "string" || typeof value === "number") return String(value);
        if (isRecord(value) && typeof value.id === "string") return value.id;
        if (isRecord(value) && typeof value.id === "number") return String(value.id);
        if (isRecord(value) && typeof value.href === "string") {
          return value.href.replace(/\/+$/, "").split("/").pop() ?? "";
        }
        return "";
      })
      .filter(Boolean);
  }

  const links = filter._links;
  if (!isRecord(links)) return [];
  const rawValues = links.values;
  const list = Array.isArray(rawValues) ? rawValues : rawValues ? [rawValues] : [];
  return list
    .map((value) => {
      if (!isRecord(value) || typeof value.href !== "string") return "";
      return value.href.replace(/\/+$/, "").split("/").pop() ?? "";
    })
    .filter(Boolean);
}

function queryIdFromWidget(widget: GridWidget): number | null {
  const options = widget.options;
  if (!isRecord(options)) return null;
  const raw = options.queryId ?? options.query_id;
  const id = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Resolve sprint filter values from a board grid's first query that has a sprint filter. */
export async function resolveBoardSprintValues(
  client: OpenProjectClient,
  boardId: number,
): Promise<string[]> {
  const grid = await client.getJson<GridResponse>(`/api/v3/grids/${boardId}`);
  const queryIds = [...new Set((grid.widgets ?? []).map(queryIdFromWidget).filter((id): id is number => id != null))];

  for (const queryId of queryIds) {
    const query = await client.getJson<QueryResponse>(`/api/v3/queries/${queryId}`);
    for (const filter of query.filters ?? []) {
      if (filterId(filter) !== "sprint") continue;
      const values = filterValues(filter);
      if (values.length > 0) return values;
    }
  }

  return [];
}
