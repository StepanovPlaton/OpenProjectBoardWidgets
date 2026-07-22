import type { DepartmentWidgetSettings } from "../types";

export function formatDepartmentLabel(
  raw: string,
  settings: DepartmentWidgetSettings,
): string {
  if (!raw) return "";
  return settings.labelMap[raw] || raw;
}

export function formatCardTitlePrefix(
  id: number,
  projectName: string,
  departmentLabel: string,
): string {
  const parts = [`#${id}`];
  if (projectName) parts.push(projectName);
  if (departmentLabel) parts.push(departmentLabel);
  return parts.join(" - ");
}
