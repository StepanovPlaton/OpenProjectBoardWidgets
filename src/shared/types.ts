export interface ConnectionSettings {
  baseUrl: string;
  token: string;
}

export interface PriorityWidgetSettings {
  enabled: boolean;
}

export interface DepartmentWidgetSettings {
  enabled: boolean;
  field: string;
  /** Custom field option ID used by "Мой отдел" board filter. Empty → button disabled. */
  filterValue: string;
  labelMap: Record<string, string>;
}

export interface StoryPointsWidgetSettings {
  enabled: boolean;
  field: string;
}

export interface PopupSelectOption {
  value: string;
  label: string;
}

export interface PopupFieldOption extends PopupSelectOption {
  fieldFormat?: string;
}

export interface PopupSettingsOptions {
  departmentFields: PopupFieldOption[];
  departmentValues: PopupSelectOption[];
  storyPointFields: PopupFieldOption[];
}

export interface BlockersWidgetSettings {
  enabled: boolean;
  doneStatusNames: string[];
  treatClosedAsDone: boolean;
}

export interface ColumnTimeWidgetSettings {
  enabled: boolean;
}

/** Counts returns from done statuses back to work (uses blockers.doneStatusNames). */
export interface ReworkReturnsWidgetSettings {
  enabled: boolean;
}

export interface NotificationsWidgetSettings {
  enabled: boolean;
}

export interface Settings {
  connection: ConnectionSettings;
  priority: PriorityWidgetSettings;
  department: DepartmentWidgetSettings;
  storyPoints: StoryPointsWidgetSettings;
  blockers: BlockersWidgetSettings;
  columnTime: ColumnTimeWidgetSettings;
  reworkReturns: ReworkReturnsWidgetSettings;
  notifications: NotificationsWidgetSettings;
  hideNativeStrip: boolean;
  /** Compact card styles for People / Estimates / Details on Overview. */
  overviewRedesign: boolean;
  /** Inject Relations + GitHub sections into Overview. */
  overviewExtended: boolean;
}

export interface PriorityInfo {
  id: number;
  name: string;
  position: number;
  color: string;
}

export interface WorkPackageSummary {
  id: number;
  subject: string;
  statusName: string;
  statusId: number | null;
  isClosed: boolean;
  priorityName: string;
  priorityId: number | null;
  projectName: string;
  projectIdentifier: string;
  department: string;
  storyPoints: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  lockVersion: number | null;
}

export interface RelationSummary {
  id: number;
  type: string;
  fromId: number;
  toId: number;
  otherId: number;
}

export interface RelationOverviewItem extends RelationSummary {
  otherSubject: string;
  otherStatusName: string;
  otherIsClosed: boolean;
}

export interface GithubCheckSummary {
  name: string;
  state: string;
  detailsUrl: string;
}

export interface GithubPullRequestOverviewItem {
  id: number;
  number: number | null;
  repositoryLabel: string;
  url: string;
  title: string;
  state: string;
  authorName: string;
  authorUrl: string;
  updatedAt: string | null;
  checks: GithubCheckSummary[];
}

export interface WorkPackageOverviewExtras {
  relations: RelationOverviewItem[];
  pullRequests: GithubPullRequestOverviewItem[];
}

export interface CiSummary {
  successful: number;
  total: number;
  allSuccessful: boolean;
  pullRequestCount: number;
}

export interface NotificationSummary {
  id: number;
  reason: string;
  readIAN: boolean;
  subject: string;
  workPackageId: number | null;
  workPackageSubject: string;
  projectName: string;
  actorName: string;
  createdAt: string | null;
}

/** Card corner badge: mention (@) wins over generic unread. */
export type CardNotificationBadge = "none" | "unread" | "mention";

export interface CardEnrichment {
  workPackage: WorkPackageSummary;
  priorityPosition: number | null;
  priorityColor: string | null;
  departmentLabel: string;
  storyPoints: number | null;
  ciSummary: CiSummary | null;
  blockersOk: boolean | null;
  columnTimeText: string | null;
  /** Times the WP left a done status for a non-done one; null if widget off. */
  reworkReturns: number | null;
}

/** Tier-2 fields loaded lazily after the fast WP enrich. */
export interface CardLazyEnrichment {
  ciSummary: CiSummary | null;
  blockersOk: boolean | null;
  columnTimeText: string | null;
  reworkReturns: number | null;
}

export type BackgroundRequest =
  | { type: "GET_SETTINGS" }
  | {
      type: "GET_SETTINGS_OPTIONS";
      connection: ConnectionSettings;
      departmentField: string;
    }
  | { type: "SAVE_SETTINGS"; settings: Settings }
  /** Tier 1: WP fields (priority, SP, department) — batch, fast. */
  | { type: "ENRICH_CARDS"; ids: number[]; force?: boolean }
  /** Tier 2: blockers, activities, GitHub CI — parallel & cached. */
  | { type: "ENRICH_CARDS_LAZY"; ids: number[] }
  | { type: "GET_WORK_PACKAGE_OVERVIEW_EXTRAS"; id: number }
  | { type: "GET_UNREAD_NOTIFICATIONS" }
  | { type: "MARK_WP_NOTIFICATIONS_READ"; workPackageId: number; notificationIds?: number[] }
  | { type: "RESOLVE_BOARD_SPRINT"; boardId: number }
  | { type: "TEST_CONNECTION" }
  | { type: "CLEAR_CACHE" };

export type BackgroundResponse =
  | { ok: true; settings: Settings }
  | { ok: true; options: PopupSettingsOptions }
  | { ok: true; enrichments: Record<string, CardEnrichment> }
  | { ok: true; lazyEnrichments: Record<string, CardLazyEnrichment> }
  | { ok: true; overviewExtras: WorkPackageOverviewExtras }
  | { ok: true; notifications: NotificationSummary[] }
  | { ok: true; sprintValues: string[] }
  | { ok: true; message: string }
  | { ok: false; error: string; code?: "UNAUTHORIZED" | "CONFIG" | "NETWORK" | "UNKNOWN" };
