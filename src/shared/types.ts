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
  /** "short" = largest unit only (как в most-bot), "full" = 2d 4h */
  format: "short" | "full";
}

export interface Settings {
  connection: ConnectionSettings;
  priority: PriorityWidgetSettings;
  department: DepartmentWidgetSettings;
  storyPoints: StoryPointsWidgetSettings;
  blockers: BlockersWidgetSettings;
  columnTime: ColumnTimeWidgetSettings;
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

export interface CardEnrichment {
  workPackage: WorkPackageSummary;
  priorityPosition: number | null;
  priorityColor: string | null;
  departmentLabel: string;
  storyPoints: number | null;
  ciSummary: CiSummary | null;
  blockersOk: boolean | null;
  columnTimeText: string | null;
}

export type BackgroundRequest =
  | { type: "GET_SETTINGS" }
  | {
      type: "GET_SETTINGS_OPTIONS";
      connection: ConnectionSettings;
      departmentField: string;
    }
  | { type: "SAVE_SETTINGS"; settings: Settings }
  | { type: "ENRICH_CARDS"; ids: number[] }
  | { type: "GET_WORK_PACKAGE_OVERVIEW_EXTRAS"; id: number }
  | { type: "BOARD_SNAPSHOT"; ids: number[] }
  | { type: "RESOLVE_BOARD_SPRINT"; boardId: number }
  | { type: "TEST_CONNECTION" }
  | { type: "CLEAR_CACHE" };

export type BackgroundResponse =
  | { ok: true; settings: Settings }
  | { ok: true; options: PopupSettingsOptions }
  | { ok: true; enrichments: Record<string, CardEnrichment> }
  | { ok: true; overviewExtras: WorkPackageOverviewExtras }
  | { ok: true; snapshotHash: string; ids: number[] }
  | { ok: true; sprintValues: string[] }
  | { ok: true; message: string }
  | { ok: false; error: string; code?: "UNAUTHORIZED" | "CONFIG" | "NETWORK" | "UNKNOWN" };
