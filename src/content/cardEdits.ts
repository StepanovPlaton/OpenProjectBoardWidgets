import { sendMessage } from "../shared/messaging";
import type {
  AssigneeOption,
  BackgroundResponse,
  CardEnrichment,
  PopupSelectOption,
  PriorityInfo,
  Settings,
  WorkPackagePatch,
} from "../shared/types";
import { contrastTextColor, formatPriorityLabel, resolvePriorityDisplay } from "../shared/widgets/priority";
import { extractWorkPackageId, type BoardCard } from "./cards";

const LOG = "[op-board-ext]";
const POPOVER_ID = "op-board-ext-edit-popover";

export interface CardEditHost {
  getSettings: () => Settings | null;
  getEnrichment: (workPackageId: number) => CardEnrichment | undefined;
  applyEnrichment: (workPackageId: number, enrichment: CardEnrichment) => void;
  findCard: (workPackageId: number) => BoardCard | undefined;
}

type PopoverKind = "priority" | "assignee" | "sp" | "department";

let host: CardEditHost | null = null;
let started = false;
let prioritiesCache: PriorityInfo[] | null = null;
let prioritiesInflight: Promise<PriorityInfo[]> | null = null;
let departmentOptionsCache: PopupSelectOption[] | null = null;
let departmentOptionsField = "";
let departmentOptionsInflight: Promise<PopupSelectOption[]> | null = null;
const assigneeCache = new Map<number, AssigneeOption[]>();
const assigneeInflight = new Map<number, Promise<AssigneeOption[]>>();
const updateInFlight = new Set<number>();
let activePopover: {
  kind: PopoverKind;
  workPackageId: number;
  anchor: HTMLElement;
} | null = null;

function stopCardOpen(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

export function initCardEdits(nextHost: CardEditHost): void {
  host = nextHost;
  if (started) return;
  started = true;

  document.addEventListener("click", onDocumentClick, true);
  document.addEventListener("keydown", onDocumentKeydown, true);
  window.addEventListener("scroll", closePopover, true);
  window.addEventListener("resize", closePopover);

  void ensurePriorities();
}

function isEditAnchor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const priority = target.closest<HTMLElement>(".op-board-ext-priority");
  if (priority && !priority.hidden) return priority;
  const sp = target.closest<HTMLElement>(".op-board-ext-sp");
  if (sp && !sp.hidden) return sp;
  const avatar = target.closest<HTMLElement>(
    ".op-board-ext-assignee-avatar, .op-board-ext-assignee-placeholder",
  );
  if (avatar) return avatar;
  const dept = target.closest<HTMLElement>(".op-board-ext-dept-slot--editable");
  if (dept && host?.getSettings()?.department.enabled) return dept;
  return null;
}

function popoverKindFor(anchor: HTMLElement): PopoverKind | null {
  if (anchor.classList.contains("op-board-ext-priority")) return "priority";
  if (anchor.classList.contains("op-board-ext-sp")) return "sp";
  if (anchor.classList.contains("op-board-ext-dept-slot")) return "department";
  return "assignee";
}

function workPackageIdFromAnchor(el: HTMLElement): number | null {
  const raw =
    el.dataset.workPackageId ||
    el.closest<HTMLElement>("[data-work-package-id]")?.dataset.workPackageId ||
    el.closest<HTMLElement>(".op-board-ext-card")?.getAttribute("data-op-board-ext");
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return extractWorkPackageId(el);
}

function onDocumentClick(event: MouseEvent): void {
  const popover = document.getElementById(POPOVER_ID);
  if (popover && event.target instanceof Node && popover.contains(event.target)) {
    return;
  }

  const anchor = isEditAnchor(event.target);
  if (anchor) {
    stopCardOpen(event);
    const kind = popoverKindFor(anchor);
    const wpId = workPackageIdFromAnchor(anchor);
    if (kind == null || wpId == null) return;

    if (
      activePopover &&
      activePopover.kind === kind &&
      activePopover.workPackageId === wpId &&
      popover
    ) {
      closePopover();
      return;
    }

    void openPopover(kind, wpId, anchor);
    return;
  }

  if (popover) closePopover();
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    closePopover();
    return;
  }

  const popover = document.getElementById(POPOVER_ID);
  if (!popover || !(event.target instanceof HTMLInputElement)) return;
  if (!popover.contains(event.target)) return;
  if (!event.target.classList.contains("op-board-ext-edit-sp-input")) return;

  if (event.key === "Enter") {
    event.preventDefault();
    commitSpFromPopover(event.target);
  }
}

function closePopover(): void {
  document.getElementById(POPOVER_ID)?.remove();
  activePopover = null;
}

function positionPopover(popover: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const pad = 6;
  popover.style.left = `${Math.round(rect.left)}px`;
  popover.style.top = `${Math.round(rect.bottom + pad)}px`;

  // Keep inside viewport after layout
  requestAnimationFrame(() => {
    const box = popover.getBoundingClientRect();
    let left = box.left;
    let top = box.top;
    if (box.right > window.innerWidth - 8) left -= box.right - (window.innerWidth - 8);
    if (left < 8) left = 8;
    if (box.bottom > window.innerHeight - 8) {
      top = rect.top - box.height - pad;
    }
    if (top < 8) top = 8;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  });
}

async function openPopover(kind: PopoverKind, workPackageId: number, anchor: HTMLElement): Promise<void> {
  if (!host) return;
  const enrichment = host.getEnrichment(workPackageId);
  if (!enrichment) return;

  closePopover();
  activePopover = { kind, workPackageId, anchor };

  const popover = document.createElement("div");
  popover.id = POPOVER_ID;
  popover.className = `op-board-ext-edit-popover op-board-ext-edit-popover--${kind}`;
  popover.setAttribute("role", "dialog");
  document.documentElement.appendChild(popover);
  positionPopover(popover, anchor);

  if (kind === "priority") {
    popover.innerHTML = `<div class="op-board-ext-edit-popover-loading">Загрузка…</div>`;
    const priorities = await ensurePriorities();
    if (!activePopover || activePopover.kind !== "priority" || activePopover.workPackageId !== workPackageId) {
      return;
    }
    renderPriorityList(popover, workPackageId, enrichment, priorities);
    positionPopover(popover, anchor);
    return;
  }

  if (kind === "assignee") {
    popover.innerHTML = `<div class="op-board-ext-edit-popover-loading">Загрузка…</div>`;
    const assignees = await ensureAssignees(workPackageId);
    if (!activePopover || activePopover.kind !== "assignee" || activePopover.workPackageId !== workPackageId) {
      return;
    }
    renderAssigneeList(popover, workPackageId, enrichment, assignees);
    positionPopover(popover, anchor);
    return;
  }

  if (kind === "department") {
    const field = host.getSettings()?.department.field.trim() || "customField2";
    popover.innerHTML = `<div class="op-board-ext-edit-popover-loading">Загрузка…</div>`;
    const options = await ensureDepartmentOptions(field);
    if (!activePopover || activePopover.kind !== "department" || activePopover.workPackageId !== workPackageId) {
      return;
    }
    renderDepartmentList(popover, workPackageId, enrichment, options);
    positionPopover(popover, anchor);
    return;
  }

  renderSpEditor(popover, workPackageId, enrichment);
  positionPopover(popover, anchor);
  const input = popover.querySelector<HTMLInputElement>(".op-board-ext-edit-sp-input");
  input?.focus();
  input?.select();
}

function renderPriorityList(
  popover: HTMLElement,
  workPackageId: number,
  enrichment: CardEnrichment,
  priorities: PriorityInfo[],
): void {
  popover.replaceChildren();
  const list = document.createElement("div");
  list.className = "op-board-ext-edit-list";
  list.setAttribute("role", "listbox");

  for (const p of priorities) {
    const { position, color } = resolvePriorityDisplay(p.id, p.name, priorities);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "op-board-ext-edit-option";
    if (enrichment.workPackage.priorityId === p.id) {
      btn.classList.add("op-board-ext-edit-option--active");
    }
    btn.setAttribute("role", "option");

    const badge = document.createElement("span");
    badge.className = "op-board-ext-edit-priority-badge";
    badge.textContent = position != null ? formatPriorityLabel(position) : "P?";
    const bg = color || p.color || "#9e9e9e";
    badge.style.backgroundColor = bg;
    badge.style.color = contrastTextColor(bg);

    const label = document.createElement("span");
    label.textContent = p.name;

    btn.append(badge, label);
    btn.addEventListener("click", (event) => {
      stopCardOpen(event);
      if (enrichment.workPackage.priorityId === p.id) {
        closePopover();
        return;
      }
      closePopover();
      void applyPatch(workPackageId, { priorityId: p.id });
    });
    list.appendChild(btn);
  }

  popover.appendChild(list);
}

function renderAssigneeList(
  popover: HTMLElement,
  workPackageId: number,
  enrichment: CardEnrichment,
  assignees: AssigneeOption[],
): void {
  popover.replaceChildren();
  const list = document.createElement("div");
  list.className = "op-board-ext-edit-list";
  list.setAttribute("role", "listbox");

  const addOption = (href: string | null, name: string, avatarUrl: string | null = null): void => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "op-board-ext-edit-option";
    const current = enrichment.workPackage.assigneeHref ?? null;
    if ((current ?? "") === (href ?? "")) {
      btn.classList.add("op-board-ext-edit-option--active");
    }
    btn.setAttribute("role", "option");

    const avatar = document.createElement("span");
    avatar.className = "op-board-ext-edit-assignee-avatar";
    if (href == null) {
      avatar.classList.add("op-board-ext-edit-assignee-avatar--empty");
      avatar.textContent = "?";
    } else {
      const initials = document.createElement("span");
      initials.className = "op-board-ext-edit-assignee-avatar-initials";
      initials.textContent = name
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase() ?? "")
        .join("") || "?";
      avatar.appendChild(initials);
      if (avatarUrl) {
        const img = document.createElement("img");
        img.alt = "";
        img.decoding = "async";
        img.loading = "lazy";
        img.src = avatarUrl;
        img.addEventListener("error", () => img.remove());
        avatar.appendChild(img);
      }
    }

    const label = document.createElement("span");
    label.textContent = name;
    btn.append(avatar, label);

    btn.addEventListener("click", (event) => {
      stopCardOpen(event);
      if ((current ?? "") === (href ?? "")) {
        closePopover();
        return;
      }
      closePopover();
      void applyPatch(workPackageId, { assigneeHref: href });
    });
    list.appendChild(btn);
  };

  addOption(null, "Не назначен");
  for (const a of assignees) {
    addOption(a.href, a.name, a.avatarUrl);
  }

  // Keep current assignee visible even if missing from available list
  const currentHref = enrichment.workPackage.assigneeHref;
  if (
    currentHref &&
    !assignees.some((a) => a.href === currentHref)
  ) {
    addOption(
      currentHref,
      enrichment.workPackage.assigneeName || currentHref,
      enrichment.workPackage.assigneeAvatarUrl,
    );
  }

  popover.appendChild(list);
}

function optionHrefFor(value: string, href?: string): string {
  if (href && href.trim()) return href.trim();
  return `/api/v3/custom_options/${value}`;
}

function renderDepartmentList(
  popover: HTMLElement,
  workPackageId: number,
  enrichment: CardEnrichment,
  options: PopupSelectOption[],
): void {
  popover.replaceChildren();
  const list = document.createElement("div");
  list.className = "op-board-ext-edit-list";
  list.setAttribute("role", "listbox");

  const currentId = enrichment.workPackage.departmentOptionId;
  const currentLabel = enrichment.workPackage.department;

  const addOption = (href: string | null, label: string, optionId: string | null): void => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "op-board-ext-edit-option";
    const isCurrent = (currentId ?? null) === (optionId ?? null);
    if (isCurrent) btn.classList.add("op-board-ext-edit-option--active");
    btn.setAttribute("role", "option");

    const label_ = document.createElement("span");
    label_.textContent = label;
    btn.appendChild(label_);

    btn.addEventListener("click", (event) => {
      stopCardOpen(event);
      if (isCurrent) {
        closePopover();
        return;
      }
      closePopover();
      void applyPatch(workPackageId, { departmentHref: href });
    });
    list.appendChild(btn);
  };

  addOption(null, "Не выбран", null);
  for (const option of options) {
    addOption(optionHrefFor(option.value, option.href), option.label, option.value);
  }

  if (currentId && !options.some((option) => option.value === currentId)) {
    addOption(optionHrefFor(currentId), currentLabel || currentId, currentId);
  }

  popover.appendChild(list);
}

async function ensureDepartmentOptions(field: string): Promise<PopupSelectOption[]> {
  if (departmentOptionsCache && departmentOptionsField === field) return departmentOptionsCache;
  if (departmentOptionsInflight && departmentOptionsField === field) return departmentOptionsInflight;

  const settings = host?.getSettings();
  if (!settings) return [];

  departmentOptionsField = field;
  departmentOptionsInflight = (async () => {
    const response = await sendMessage<BackgroundResponse>({
      type: "GET_DEPARTMENT_OPTIONS",
      connection: settings.connection,
      departmentField: field,
    });
    if (!response.ok || !("departmentOptions" in response)) {
      throw new Error(!response.ok ? response.error : "No department options payload");
    }
    departmentOptionsCache = response.departmentOptions;
    return departmentOptionsCache;
  })()
    .catch((error) => {
      console.warn(`${LOG} load department options failed`, error);
      return [] as PopupSelectOption[];
    })
    .finally(() => {
      departmentOptionsInflight = null;
    });

  return departmentOptionsInflight;
}

function renderSpEditor(
  popover: HTMLElement,
  workPackageId: number,
  enrichment: CardEnrichment,
): void {
  popover.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "op-board-ext-edit-sp";

  const label = document.createElement("label");
  label.className = "op-board-ext-edit-sp-label";
  label.textContent = "Story Points";

  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.step = "1";
  input.inputMode = "numeric";
  input.className = "op-board-ext-edit-sp-input";
  input.dataset.workPackageId = String(workPackageId);
  input.value =
    enrichment.storyPoints == null || !Number.isFinite(enrichment.storyPoints)
      ? ""
      : String(enrichment.storyPoints);
  input.setAttribute("aria-label", "Story Points");

  input.addEventListener("mousedown", stopCardOpen);
  input.addEventListener("click", stopCardOpen);
  input.addEventListener("blur", () => {
    // Defer so a click on another option can run first
    window.setTimeout(() => {
      if (document.getElementById(POPOVER_ID)?.contains(input)) {
        commitSpFromPopover(input);
      }
    }, 0);
  });

  wrap.append(label, input);
  popover.appendChild(wrap);
}

function parseSpInput(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function commitSpFromPopover(input: HTMLInputElement): void {
  const wpId = Number(input.dataset.workPackageId);
  if (!Number.isFinite(wpId) || wpId <= 0) {
    closePopover();
    return;
  }

  const parsed = parseSpInput(input.value);
  if (parsed === undefined) {
    const current = host?.getEnrichment(wpId)?.storyPoints ?? null;
    input.value = current == null ? "" : String(current);
    closePopover();
    return;
  }

  const current = host?.getEnrichment(wpId)?.storyPoints ?? null;
  closePopover();
  if (current === parsed) return;
  void applyPatch(wpId, { storyPoints: parsed });
}

async function ensurePriorities(): Promise<PriorityInfo[]> {
  if (prioritiesCache) return prioritiesCache;
  if (prioritiesInflight) return prioritiesInflight;

  prioritiesInflight = (async () => {
    const response = await sendMessage<BackgroundResponse>({ type: "GET_PRIORITIES" });
    if (!response.ok || !("priorities" in response)) {
      throw new Error(!response.ok ? response.error : "No priorities payload");
    }
    prioritiesCache = response.priorities;
    return prioritiesCache;
  })()
    .catch((error) => {
      console.warn(`${LOG} load priorities failed`, error);
      return [] as PriorityInfo[];
    })
    .finally(() => {
      prioritiesInflight = null;
    });

  return prioritiesInflight;
}

async function ensureAssignees(workPackageId: number): Promise<AssigneeOption[]> {
  const cached = assigneeCache.get(workPackageId);
  if (cached) return cached;

  const inflight = assigneeInflight.get(workPackageId);
  if (inflight) return inflight;

  const promise = (async () => {
    const response = await sendMessage<BackgroundResponse>({
      type: "GET_ASSIGNEE_OPTIONS",
      workPackageId,
    });
    if (!response.ok || !("assignees" in response)) {
      throw new Error(!response.ok ? response.error : "No assignees payload");
    }
    assigneeCache.set(workPackageId, response.assignees);
    return response.assignees;
  })()
    .catch((error) => {
      console.warn(`${LOG} load assignees failed`, error);
      return [] as AssigneeOption[];
    })
    .finally(() => {
      assigneeInflight.delete(workPackageId);
    });

  assigneeInflight.set(workPackageId, promise);
  return promise;
}

async function applyPatch(
  workPackageId: number,
  patch: Omit<WorkPackagePatch, "lockVersion">,
): Promise<void> {
  if (!host) return;
  if (updateInFlight.has(workPackageId)) return;

  const enrichment = host.getEnrichment(workPackageId);
  const lockVersion = enrichment?.workPackage.lockVersion;
  if (lockVersion == null) {
    console.warn(`${LOG} cannot update #${workPackageId}: missing lockVersion`);
    return;
  }

  updateInFlight.add(workPackageId);
  try {
    const response = await sendMessage<BackgroundResponse>({
      type: "UPDATE_WORK_PACKAGE",
      id: workPackageId,
      patch: { ...patch, lockVersion },
    });
    if (!response.ok || !("enrichment" in response)) {
      console.warn(
        `${LOG} update work package failed`,
        !response.ok ? response.error : "No enrichment payload",
      );
      return;
    }
    host.applyEnrichment(workPackageId, response.enrichment);
  } catch (error) {
    console.warn(`${LOG} update work package failed`, error);
  } finally {
    updateInFlight.delete(workPackageId);
  }
}
