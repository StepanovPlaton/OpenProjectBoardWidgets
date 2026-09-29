import type { Settings, WipLimitRule, WipWidgetSettings } from "./types";

export const STORAGE_KEY = "opBoardSettings";

/** Built-in WIP rules when «настройки по умолчанию» are enabled. */
export const DEFAULT_WIP_LIMITS: WipLimitRule[] = [
  { match: "In Progress", limit: 10 },
  { match: "Review", limit: 3 },
  { match: "QA", limit: 2 },
];

export const DEFAULT_SETTINGS: Settings = {
  connection: {
    baseUrl: "http://83.222.19.230:8081",
    token: "",
  },
  priority: {
    enabled: true,
  },
  department: {
    enabled: true,
    field: "customField2",
    filterValue: "",
    labelMap: {
      Backend: "Backend",
      Frontend: "Frontend",
      Design: "Design",
      QA: "QA",
      Бэкенд: "Backend",
      Фронтенд: "Frontend",
      Дизайн: "Design",
      Тестирование: "QA",
    },
  },
  storyPoints: {
    enabled: true,
    field: "storyPoints",
  },
  review: {
    enabled: true,
    field: "customField8",
    greenId: "6",
    yellowId: "7",
    redId: "8",
  },
  blockers: {
    enabled: true,
    doneStatusNames: ["Done (TS)", "Done", "ПРИНЯТО", "QA"],
    treatClosedAsDone: true,
  },
  columnTime: {
    enabled: true,
  },
  reworkReturns: {
    enabled: true,
  },
  notifications: {
    enabled: true,
  },
  wip: {
    enabled: true,
    borderEnabled: true,
    useDefaults: true,
    limits: [],
  },
  hideNativeStrip: true,
  overviewRedesign: true,
  overviewExtended: true,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeSettings(raw: unknown): Settings {
  if (!isObject(raw)) {
    return structuredClone(DEFAULT_SETTINGS);
  }

  const base = structuredClone(DEFAULT_SETTINGS);
  const connection = isObject(raw.connection) ? raw.connection : {};
  const priority = isObject(raw.priority) ? raw.priority : {};
  const department = isObject(raw.department) ? raw.department : {};
  const storyPoints = isObject(raw.storyPoints) ? raw.storyPoints : {};
  const review = isObject(raw.review) ? raw.review : {};
  const blockers = isObject(raw.blockers) ? raw.blockers : {};
  const columnTime = isObject(raw.columnTime) ? raw.columnTime : {};
  const reworkReturns = isObject(raw.reworkReturns) ? raw.reworkReturns : {};
  const notifications = isObject(raw.notifications) ? raw.notifications : {};
  const wip = isObject(raw.wip) ? raw.wip : {};

  return {
    connection: {
      baseUrl: typeof connection.baseUrl === "string" ? connection.baseUrl : base.connection.baseUrl,
      token: typeof connection.token === "string" ? connection.token : base.connection.token,
    },
    priority: {
      enabled: typeof priority.enabled === "boolean" ? priority.enabled : base.priority.enabled,
    },
    department: {
      enabled: typeof department.enabled === "boolean" ? department.enabled : base.department.enabled,
      field: typeof department.field === "string" ? department.field : base.department.field,
      filterValue:
        typeof department.filterValue === "string" ? department.filterValue.trim() : base.department.filterValue,
      labelMap:
        isObject(department.labelMap) && Object.keys(department.labelMap).length > 0
          ? (department.labelMap as Record<string, string>)
          : base.department.labelMap,
    },
    storyPoints: {
      enabled: typeof storyPoints.enabled === "boolean" ? storyPoints.enabled : base.storyPoints.enabled,
      field: typeof storyPoints.field === "string" ? storyPoints.field : base.storyPoints.field,
    },
    review: {
      enabled: typeof review.enabled === "boolean" ? review.enabled : base.review.enabled,
      field:
        typeof review.field === "string" && review.field.trim()
          ? review.field.trim()
          : base.review.field,
      greenId:
        typeof review.greenId === "string" && review.greenId.trim()
          ? review.greenId.trim()
          : base.review.greenId,
      yellowId:
        typeof review.yellowId === "string" && review.yellowId.trim()
          ? review.yellowId.trim()
          : base.review.yellowId,
      redId:
        typeof review.redId === "string" && review.redId.trim()
          ? review.redId.trim()
          : base.review.redId,
    },
    blockers: {
      enabled: typeof blockers.enabled === "boolean" ? blockers.enabled : base.blockers.enabled,
      doneStatusNames: Array.isArray(blockers.doneStatusNames)
        ? blockers.doneStatusNames.filter((x): x is string => typeof x === "string")
        : base.blockers.doneStatusNames,
      treatClosedAsDone:
        typeof blockers.treatClosedAsDone === "boolean"
          ? blockers.treatClosedAsDone
          : base.blockers.treatClosedAsDone,
    },
    columnTime: {
      enabled: typeof columnTime.enabled === "boolean" ? columnTime.enabled : base.columnTime.enabled,
    },
    reworkReturns: {
      enabled:
        typeof reworkReturns.enabled === "boolean" ? reworkReturns.enabled : base.reworkReturns.enabled,
    },
    notifications: {
      enabled:
        typeof notifications.enabled === "boolean" ? notifications.enabled : base.notifications.enabled,
    },
    wip: {
      enabled: typeof wip.enabled === "boolean" ? wip.enabled : base.wip.enabled,
      borderEnabled: typeof wip.borderEnabled === "boolean" ? wip.borderEnabled : base.wip.borderEnabled,
      useDefaults: typeof wip.useDefaults === "boolean" ? wip.useDefaults : base.wip.useDefaults,
      limits: Array.isArray(wip.limits)
        ? wip.limits
            .filter(isObject)
            .map((rule) => ({
              match: typeof rule.match === "string" ? rule.match.trim() : "",
              limit: typeof rule.limit === "number" ? rule.limit : Number(rule.limit),
            }))
            .filter((rule) => rule.match.length > 0 && Number.isFinite(rule.limit) && rule.limit > 0)
            .map((rule) => ({ match: rule.match, limit: Math.floor(rule.limit) }))
        : base.wip.limits,
    },
    hideNativeStrip: typeof raw.hideNativeStrip === "boolean" ? raw.hideNativeStrip : base.hideNativeStrip,
    overviewRedesign:
      typeof raw.overviewRedesign === "boolean" ? raw.overviewRedesign : base.overviewRedesign,
    // Migrate older installs that only had overviewRedesign.
    overviewExtended:
      typeof raw.overviewExtended === "boolean"
        ? raw.overviewExtended
        : typeof raw.overviewRedesign === "boolean"
          ? raw.overviewRedesign
          : base.overviewExtended,
  };
}

export async function loadSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  return mergeSettings(result[STORAGE_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Active WIP rules: built-in defaults or custom list. */
export function getActiveWipLimits(wip: WipWidgetSettings): WipLimitRule[] {
  return wip.useDefaults ? DEFAULT_WIP_LIMITS : wip.limits;
}
