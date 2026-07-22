import type { PriorityInfo } from "../types";

/**
 * Board scale (lower number = higher urgency):
 * P1 Immediate — purple
 * P2 High — red
 * P3 Important — yellow
 * P4 Normal — blue
 * P5 Low — gray
 */
const RANK_BY_NAME: Record<string, number> = {
  immediate: 1,
  безотлагательный: 1,
  высочайший: 1,
  high: 2,
  высокий: 2,
  important: 3,
  важный: 3,
  normal: 4,
  нормальный: 4,
  обычный: 4,
  low: 5,
  низкий: 5,
};

const COLOR_BY_RANK: Record<number, string> = {
  1: "#8e24aa", // фиолетовый
  2: "#e53935", // красный
  3: "#fdd835", // жёлтый
  4: "#29b6f6", // голубой
  5: "#9e9e9e", // серый
};

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function resolvePriorityDisplay(
  priorityId: number | null,
  priorityName: string,
  priorities: PriorityInfo[],
): { position: number | null; color: string | null } {
  let info = priorityId != null ? priorities.find((p) => p.id === priorityId) : undefined;
  if (!info && priorityName) {
    info = priorities.find((p) => normalizeName(p.name) === normalizeName(priorityName));
  }

  const name = info?.name || priorityName || "";
  const rank = RANK_BY_NAME[normalizeName(name)];
  if (rank != null) {
    return { position: rank, color: COLOR_BY_RANK[rank] };
  }

  // Fallback: OP position if name is unknown
  if (info && Number.isFinite(info.position)) {
    const position = info.position;
    return {
      position,
      color: COLOR_BY_RANK[position] || info.color?.trim() || "#9e9e9e",
    };
  }

  return { position: null, color: null };
}

export function formatPriorityLabel(position: number): string {
  return `P${position}`;
}

/** Pick readable text color for a given background hex/rgb. */
export function contrastTextColor(background: string | null): string {
  if (!background) return "#fff";
  const rgb = parseCssColor(background);
  if (!rgb) return "#fff";
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? "#1a1a1a" : "#ffffff";
}

function parseCssColor(value: string): [number, number, number] | null {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    if (raw.length === 3) {
      return [
        parseInt(raw[0] + raw[0], 16),
        parseInt(raw[1] + raw[1], 16),
        parseInt(raw[2] + raw[2], 16),
      ];
    }
    return [
      parseInt(raw.slice(0, 2), 16),
      parseInt(raw.slice(2, 4), 16),
      parseInt(raw.slice(4, 6), 16),
    ];
  }
  const rgb = value.trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return null;
}
