const CARD_ROOT_ATTR = "data-op-board-ext";
const RENDER_FP_ATTR = "data-op-ext-fp";

/** Prefer real OpenProject board cards */
const CARD_SELECTORS = [
  "wp-single-card",
  "[data-work-package-id]",
  "[data-test-selector='op-wp-single-card']",
  "[data-qa-selector='op-wp-single-card']",
  ".op-wp-single-card",
];

const WP_HREF_RE = /\/work_packages\/(\d+)(?:\/|$|\?|#)/i;

export interface BoardCard {
  root: HTMLElement;
  workPackageId: number;
}

export function extractWorkPackageId(el: Element): number | null {
  const host =
    (el.closest("wp-single-card,[data-work-package-id]") as HTMLElement | null) ||
    (el instanceof HTMLElement ? el : null);

  const dataId =
    host?.getAttribute("data-work-package-id") ||
    el.getAttribute("data-work-package-id") ||
    el.getAttribute("data-wp-id") ||
    el.querySelector("[data-work-package-id]")?.getAttribute("data-work-package-id");
  if (dataId) {
    const n = Number(dataId);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const anchors = [
    el instanceof HTMLAnchorElement ? el : null,
    ...Array.from(el.querySelectorAll("a[href*='work_packages']")),
  ].filter((a): a is HTMLAnchorElement => a != null);

  for (const a of anchors) {
    const match = a.getAttribute("href")?.match(WP_HREF_RE);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }

  return null;
}

function isLikelyCard(el: HTMLElement): boolean {
  if (el.closest(`[${CARD_ROOT_ATTR}-ignore]`)) return false;
  // Skip huge containers that only wrap many cards
  if (el.querySelectorAll("[data-work-package-id], wp-single-card").length > 1) {
    // Still allow the element if it itself has the id attribute
    if (!el.hasAttribute("data-work-package-id") && el.tagName.toLowerCase() !== "wp-single-card") {
      return false;
    }
  }
  return extractWorkPackageId(el) != null;
}

function resolveCardRoot(el: HTMLElement): HTMLElement {
  const host = el.closest("wp-single-card") as HTMLElement | null;
  if (host) return host;
  if (el.hasAttribute("data-work-package-id")) return el;
  const withId = el.closest("[data-work-package-id]") as HTMLElement | null;
  return withId ?? el;
}

export function findBoardCards(root: ParentNode = document): BoardCard[] {
  const found = new Map<HTMLElement, number>();

  for (const selector of CARD_SELECTORS) {
    root.querySelectorAll(selector).forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      if (!isLikelyCard(node)) return;
      const cardRoot = resolveCardRoot(node);
      const id = extractWorkPackageId(cardRoot);
      if (id == null) return;
      found.set(cardRoot, id);
    });
  }

  // Extra pass: any work package id on the page (boards often render slowly)
  root.querySelectorAll("[data-work-package-id]").forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    const id = Number(node.getAttribute("data-work-package-id"));
    if (!Number.isFinite(id) || id <= 0) return;
    const cardRoot = resolveCardRoot(node);
    found.set(cardRoot, id);
  });

  const byId = new Map<number, HTMLElement>();
  for (const [el, id] of found) {
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, el);
      continue;
    }
    const elIsHost = el.tagName.toLowerCase() === "wp-single-card";
    const existingIsHost = existing.tagName.toLowerCase() === "wp-single-card";
    if (elIsHost && !existingIsHost) {
      byId.set(id, el);
    } else if (!elIsHost && existingIsHost) {
      // keep host
    } else if (existing.contains(el)) {
      byId.set(id, el);
    }
  }

  return [...byId.entries()].map(([workPackageId, rootEl]) => ({
    root: rootEl,
    workPackageId,
  }));
}

/** Debug snapshot when discovery returns empty. */
export function diagnoseCardDom(root: ParentNode = document): Record<string, number | string[]> {
  const wpSingle = root.querySelectorAll("wp-single-card").length;
  const byDataId = root.querySelectorAll("[data-work-package-id]").length;
  const byTestSel = root.querySelectorAll("[data-test-selector='op-wp-single-card']").length;
  const byClass = root.querySelectorAll(".op-wp-single-card").length;
  const boardish = root.querySelectorAll("[class*='board'], [class*='wp-card'], wp-card").length;
  const sampleHrefs = [...root.querySelectorAll("a[href*='/work_packages/']")]
    .slice(0, 5)
    .map((a) => a.getAttribute("href") || "");
  return { wpSingle, byDataId, byTestSel, byClass, boardish, sampleHrefs };
}

export function markCard(root: HTMLElement, workPackageId: number): void {
  root.setAttribute(CARD_ROOT_ATTR, String(workPackageId));
}

export function getRenderFingerprint(root: HTMLElement): string | null {
  return root.getAttribute(RENDER_FP_ATTR);
}

export function setRenderFingerprint(root: HTMLElement, fp: string): void {
  root.setAttribute(RENDER_FP_ATTR, fp);
}

export function getCardSurface(root: HTMLElement): HTMLElement {
  if (root.classList.contains("op-wp-single-card")) return root;
  const inner = root.querySelector<HTMLElement>(
    ".op-wp-single-card, [data-test-selector='op-wp-single-card']",
  );
  return inner ?? root;
}

export function getCardContent(root: HTMLElement): HTMLElement | null {
  return getCardSurface(root).querySelector<HTMLElement>(".op-wp-single-card--content");
}

/**
 * Put department into the native project-name slot so OP grid/flex alignment
 * for `#id - …` stays correct (hiding that node shifts the id).
 */
export function applyDepartmentAfterId(
  root: HTMLElement,
  departmentLabel: string,
  enabled: boolean,
): void {
  // Remove leftover inline dept spans from older builds
  root.querySelectorAll(".op-board-ext-dept").forEach((el) => el.remove());

  const projectName = root.querySelector<HTMLElement>(".op-wp-single-card--content-project-name");
  if (!projectName) return;

  projectName.classList.remove("op-board-ext-hide-project");
  projectName.classList.add("op-board-ext-dept-slot");

  if (enabled && departmentLabel) {
    const next = ` - ${departmentLabel} `;
    if (projectName.textContent !== next) {
      projectName.textContent = next;
    }
    projectName.hidden = false;
  } else if (enabled) {
    // Keep slot but empty so layout does not jump; collapse visually
    if (projectName.textContent !== "") {
      projectName.textContent = "";
    }
  }
}

export function ensureAssigneeRow(
  root: HTMLElement,
  options?: { hasAssignee?: boolean; assigneeName?: string; assigneeAvatarUrl?: string | null },
): HTMLElement | null {
  const content = getCardContent(root);
  if (!content) return null;

  const native = content.querySelector<HTMLElement>(
    ".op-wp-single-card--content-assignee:not(.op-board-ext-assignee-row)",
  );
  const fallback = content.querySelector<HTMLElement>(".op-board-ext-assignee-row");

  let assignee = native ?? fallback ?? null;

  if (native && fallback && fallback !== native) {
    fallback.remove();
    assignee = native;
  }

  if (!assignee) {
    // No native assignee row (common for unassigned cards) — create ours.
    assignee = document.createElement("div");
    assignee.className =
      "op-wp-single-card--content-assignee op-board-ext-assignee op-board-ext-assignee-row";
    content.appendChild(assignee);
  } else {
    assignee.classList.add("op-board-ext-assignee");
  }

  // Always hide OpenProject's native avatar — we render our own chip.
  hideNativeAssigneeVisuals(content, assignee);

  const hasAssignee = options?.hasAssignee === true;
  syncAssigneeAvatar(assignee, {
    hasAssignee,
    assigneeName: options?.assigneeName ?? "",
    avatarUrl: options?.assigneeAvatarUrl ?? null,
  });
  return assignee;
}

function hideNativeAssigneeVisuals(content: HTMLElement, assigneeRow: HTMLElement): void {
  const nodes = content.querySelectorAll<HTMLElement>(
    "op-principal, .op-principal, .op-avatar, .op-principal--avatar, .avatar, img.avatar",
  );
  for (const el of nodes) {
    // Keep our injected widgets; only hide OP avatar chrome
    if (el.closest(".op-board-ext-assignee-avatar")) continue;
    if (el === assigneeRow) continue;
    el.classList.add("op-board-ext-hide-native-assignee");
  }
}

function assigneeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Always-on custom assignee chip (replaces native OP avatar). */
function syncAssigneeAvatar(
  assignee: HTMLElement,
  opts: { hasAssignee: boolean; assigneeName: string; avatarUrl: string | null },
): void {
  let chip = assignee.querySelector<HTMLElement>(":scope > .op-board-ext-assignee-avatar");
  if (!chip) {
    chip = document.createElement("span");
    chip.className = "op-board-ext-assignee-avatar";
    chip.setAttribute("role", "button");
  }

  chip.replaceChildren();

  if (opts.hasAssignee) {
    const name = opts.assigneeName.trim() || "Исполнитель";
    chip.classList.remove("op-board-ext-assignee-avatar--empty");
    chip.classList.add("op-board-ext-assignee-avatar--assigned");
    chip.title = `Исполнитель: ${name}`;
    chip.setAttribute("aria-label", `Исполнитель: ${name}`);

    const initials = document.createElement("span");
    initials.className = "op-board-ext-assignee-avatar-initials";
    initials.textContent = assigneeInitials(name);
    chip.appendChild(initials);

    if (opts.avatarUrl) {
      const img = document.createElement("img");
      img.className = "op-board-ext-assignee-avatar-img";
      img.alt = "";
      img.decoding = "async";
      img.loading = "lazy";
      img.src = opts.avatarUrl;
      img.addEventListener("error", () => {
        img.remove();
      });
      chip.appendChild(img);
    }
  } else {
    chip.classList.remove("op-board-ext-assignee-avatar--assigned");
    chip.classList.add("op-board-ext-assignee-avatar--empty");
    chip.textContent = "?";
    chip.title = "Назначить исполнителя";
    chip.setAttribute("aria-label", "Назначить исполнителя");
  }

  assignee.querySelectorAll(":scope > .op-board-ext-assignee-placeholder").forEach((el) => el.remove());

  const priority = assignee.querySelector<HTMLElement>(":scope > .op-board-ext-priority");
  if (priority) {
    if (chip.previousElementSibling !== priority) {
      priority.after(chip);
    }
  } else if (chip.parentElement !== assignee || chip !== assignee.firstElementChild) {
    assignee.insertBefore(chip, assignee.firstChild);
  }
}

/** Priority circle — first child of assignee (before avatar). */
export function ensurePrioritySlot(assignee: HTMLElement): HTMLElement {
  const existing = assignee.querySelector(":scope > .op-board-ext-priority");
  if (existing && !(existing instanceof HTMLSpanElement)) {
    // Migrate away from previous <select> experiments
    existing.remove();
  }

  let el = assignee.querySelector<HTMLElement>(":scope > .op-board-ext-priority");
  if (!el) {
    el = document.createElement("span");
    el.className = "op-board-ext-priority";
    assignee.insertBefore(el, assignee.firstChild);
  } else if (el !== assignee.firstElementChild) {
    assignee.insertBefore(el, assignee.firstChild);
  }
  return el;
}

/** SP badge after avatar inside assignee. */
export function ensureSpSlot(assignee: HTMLElement): HTMLElement {
  // migrate old meta wrappers
  const oldMeta = assignee.querySelector<HTMLElement>(":scope > .op-board-ext-meta");
  if (oldMeta) {
    const existingSp = oldMeta.querySelector(".op-board-ext-sp");
    if (existingSp) assignee.appendChild(existingSp);
    oldMeta.remove();
  }

  // Remove leftover assignee <select> from previous edit UI
  assignee.querySelectorAll(":scope > .op-board-ext-assignee-select").forEach((n) => n.remove());

  let el = assignee.querySelector<HTMLElement>(":scope > .op-board-ext-sp");
  if (!el) {
    el = document.createElement("span");
    el.className = "op-board-ext-sp";
    assignee.appendChild(el);
  }
  return el;
}

/** CI badge after SP inside assignee. */
export function ensureCiSlot(assignee: HTMLElement): HTMLElement {
  let el = assignee.querySelector<HTMLElement>(":scope > .op-board-ext-ci");
  if (!el) {
    el = document.createElement("span");
    el.className = "op-board-ext-ci";
    assignee.appendChild(el);
  }
  return el;
}

/** Rework-returns badge after CI (or SP) inside assignee. */
export function ensureReworkSlot(assignee: HTMLElement): HTMLElement {
  let el = assignee.querySelector<HTMLElement>(":scope > .op-board-ext-rework");
  if (!el) {
    el = document.createElement("span");
    el.className = "op-board-ext-rework";
  }

  const ci = assignee.querySelector<HTMLElement>(":scope > .op-board-ext-ci");
  const sp = assignee.querySelector<HTMLElement>(":scope > .op-board-ext-sp");
  const anchor = ci ?? sp;
  if (anchor) {
    if (el.previousElementSibling !== anchor) {
      anchor.after(el);
    }
  } else if (el.parentElement !== assignee) {
    assignee.appendChild(el);
  }

  return el;
}

/** Blockers badge overlays the native details (i) button without moving it. */
export function ensureBlockersSlot(root: HTMLElement): HTMLElement {
  const surface = getCardSurface(root);
  surface.classList.add("op-board-ext-surface");

  // Clean up misplaced blockers from older layouts
  surface.querySelectorAll(".op-board-ext-blockers").forEach((el) => {
    if (!el.closest(".op-wp-single-card--details-button")) {
      el.remove();
    }
  });

  const detailsBtn = surface.querySelector<HTMLElement>(".op-wp-single-card--details-button");
  if (detailsBtn) {
    detailsBtn.classList.add("op-board-ext-details-btn");
    let el = detailsBtn.querySelector<HTMLElement>(":scope > .op-board-ext-blockers");
    if (!el) {
      el = document.createElement("span");
      el.className = "op-board-ext-blockers";
      detailsBtn.appendChild(el);
    }
    return el;
  }

  // Fallback: surface corner (should rarely happen)
  let el = surface.querySelector<HTMLElement>(":scope > .op-board-ext-blockers");
  if (!el) {
    el = document.createElement("span");
    el.className = "op-board-ext-blockers";
    surface.appendChild(el);
  }
  return el;
}


export function ensureTimeSlot(root: HTMLElement): HTMLElement {
  const surface = getCardSurface(root);
  surface.classList.add("op-board-ext-surface");

  let el = surface.querySelector<HTMLElement>(":scope > .op-board-ext-time");
  if (!el) {
    el = document.createElement("span");
    el.className = "op-board-ext-time";
    surface.appendChild(el);
  }
  return el;
}

export function cleanupLegacyNodes(root: HTMLElement): void {
  root
    .querySelectorAll(".op-board-ext-title, .op-board-ext-footer, .op-board-ext-meta")
    .forEach((el) => el.remove());
}

export function isExtensionNode(node: Node): boolean {
  if (node instanceof Element) {
    if (
      node.classList.contains("op-board-ext-dept") ||
      node.classList.contains("op-board-ext-priority") ||
      node.classList.contains("op-board-ext-sp") ||
      node.classList.contains("op-board-ext-ci") ||
      node.classList.contains("op-board-ext-rework") ||
      node.classList.contains("op-board-ext-blockers") ||
      node.classList.contains("op-board-ext-time") ||
      node.classList.contains("op-board-ext-notif") ||
      node.classList.contains("op-board-ext-assignee-placeholder") ||
      node.classList.contains("op-board-ext-assignee-avatar") ||
      node.classList.contains("op-board-ext-assignee-row") ||
      node.classList.contains("op-board-ext-hide-native-assignee") ||
      node.id === "op-board-ext-notif-toasts" ||
      node.id === "op-board-ext-edit-popover"
    ) {
      return true;
    }
    if (node.closest?.("[class*='op-board-ext'], #op-board-ext-notif-toasts")) return true;
  }
  if (node instanceof Text) {
    const parent = node.parentElement;
    if (parent && isExtensionNode(parent)) return true;
  }
  return false;
}

export { CARD_ROOT_ATTR, RENDER_FP_ATTR };
