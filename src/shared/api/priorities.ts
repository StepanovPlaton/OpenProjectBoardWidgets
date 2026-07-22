import type { OpenProjectClient } from "./client";
import type { PriorityInfo } from "../types";

export async function fetchPriorities(client: OpenProjectClient): Promise<PriorityInfo[]> {
  const elements = await client.getCollection<Record<string, unknown>>("/api/v3/priorities");
  return elements
    .map((item) => {
      const id = Number(item.id);
      const position = Number(item.position);
      const name = typeof item.name === "string" ? item.name : "";
      const color = typeof item.color === "string" ? item.color : "";
      return { id, name, position: Number.isFinite(position) ? position : 99, color };
    })
    .filter((p) => Number.isFinite(p.id))
    .sort((a, b) => a.position - b.position);
}
