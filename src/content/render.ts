import type { CardEnrichment, Settings } from "../shared/types";
import { contrastTextColor, formatPriorityLabel } from "../shared/widgets/priority";
import { reworkSeverity } from "../shared/widgets/reworkReturns";
import {
  applyDepartmentAfterId,
  cleanupLegacyNodes,
  ensureAssigneeRow,
  ensureBlockersSlot,
  ensureCiSlot,
  ensurePrioritySlot,
  ensureReworkSlot,
  ensureSpSlot,
  ensureTimeSlot,
  getCardSurface,
  getRenderFingerprint,
  markCard,
  setRenderFingerprint,
  type BoardCard,
} from "./cards";

const LIGHTBULB_SVG = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path fill-rule="evenodd" clip-rule="evenodd" d="M10.0512 15.75L9.51642 14.2768L9.18821 14.0137C8.15637 13.1865 7.5 11.9204 7.5 10.5C7.5 8.01472 9.51472 6 12 6C14.4853 6 16.5 8.01472 16.5 10.5C16.5 11.9204 15.8436 13.1865 14.8118 14.0137L14.4836 14.2768L13.9488 15.75H10.0512ZM9 17.25H15L15.75 15.184C17.1217 14.0844 18 12.3948 18 10.5C18 7.18629 15.3137 4.5 12 4.5C8.68629 4.5 6 7.18629 6 10.5C6 12.3948 6.87831 14.0844 8.25 15.184L9 17.25ZM14.25 19.5V18H9.75V19.5H14.25Z" fill="currentColor"></path>
</svg>
`.trim();

const CI_SVG = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path fill-rule="evenodd" clip-rule="evenodd" d="M13.4142 3.82843C12.6332 3.04738 11.3668 3.04738 10.5858 3.82843L9.91421 4.5L11.482 6.06774C11.6472 6.02356 11.8208 6 12 6C13.1046 6 14 6.89543 14 8C14 8.17916 13.9764 8.35282 13.9323 8.51804L15.982 10.5677C16.1472 10.5236 16.3208 10.5 16.5 10.5C17.6046 10.5 18.5 11.3954 18.5 12.5C18.5 13.6046 17.6046 14.5 16.5 14.5C15.3954 14.5 14.5 13.6046 14.5 12.5C14.5 12.3208 14.5236 12.1472 14.5677 11.982L13 10.4142V15.2676C13.5978 15.6134 14 16.2597 14 17C14 18.1046 13.1046 19 12 19C10.8954 19 10 18.1046 10 17C10 16.2597 10.4022 15.6134 11 15.2676V9.73244C10.4022 9.38663 10 8.74028 10 8C10 7.82084 10.0236 7.64718 10.0677 7.48196L8.5 5.91421L3.82843 10.5858C3.04738 11.3668 3.04738 12.6332 3.82843 13.4142L10.5858 20.1716C11.3668 20.9526 12.6332 20.9526 13.4142 20.1716L20.1716 13.4142C20.9526 12.6332 20.9526 11.3668 20.1716 10.5858L13.4142 3.82843ZM9.17157 2.41421C10.7337 0.852115 13.2663 0.852119 14.8284 2.41422L21.5858 9.17157C23.1479 10.7337 23.1479 13.2663 21.5858 14.8284L14.8284 21.5858C13.2663 23.1479 10.7337 23.1479 9.17157 21.5858L2.41421 14.8284C0.852115 13.2663 0.852119 10.7337 2.41422 9.17157L9.17157 2.41421Z" fill="currentColor"></path>
</svg>
`.trim();

const REWORK_SVG = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M12 6.5C12.5523 6.5 13 6.94772 13 7.5L13 13.5C13 14.0523 12.5523 14.5 12 14.5C11.4477 14.5 11 14.0523 11 13.5L11 7.5C11 6.94772 11.4477 6.5 12 6.5Z" fill="currentColor"></path>
  <path d="M12 18.5C12.8284 18.5 13.5 17.8284 13.5 17C13.5 16.1716 12.8284 15.5 12 15.5C11.1716 15.5 10.5 16.1716 10.5 17C10.5 17.8284 11.1716 18.5 12 18.5Z" fill="currentColor"></path>
  <path fill-rule="evenodd" clip-rule="evenodd" d="M9.82664 2.22902C10.7938 0.590326 13.2063 0.590325 14.1735 2.22902L23.6599 18.3024C24.6578 19.9933 23.3638 22 21.4865 22H2.51362C0.63634 22 -0.657696 19.9933 0.340215 18.3024L9.82664 2.22902ZM12.4511 3.24557C12.2578 2.91814 11.7423 2.91814 11.549 3.24557L2.06261 19.319C1.90904 19.5792 2.07002 20 2.51362 20H21.4865C21.9301 20 22.0911 19.5792 21.9375 19.319L12.4511 3.24557Z" fill="currentColor"></path>
</svg>
`.trim();

function applyHideStrip(enabled: boolean): void {
  document.documentElement.classList.toggle("op-board-ext-hide-strip", enabled);
}

export function applySettingsToDom(settings: Settings): void {
  applyHideStrip(settings.hideNativeStrip);
}

function formatSpValue(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : String(value);
}

function visibleWidget(root: HTMLElement, selector: string): boolean {
  const el = root.querySelector<HTMLElement>(selector);
  return el != null && !el.hidden;
}

/** Why cardNeedsRestore would return true — for flicker diagnostics. */
export function diagnoseRestoreReasons(
  root: HTMLElement,
  enrichment: CardEnrichment,
  settings: Settings,
): string[] {
  const reasons: string[] = [];
  if (settings.department.enabled && enrichment.departmentLabel) {
    if (!root.querySelector(".op-board-ext-dept-slot")) reasons.push("missing-dept-slot");
  }
  if (settings.priority.enabled && enrichment.priorityPosition != null) {
    if (!visibleWidget(root, ".op-board-ext-priority")) reasons.push("missing-priority");
  }
  if (!visibleWidget(root, ".op-board-ext-assignee-avatar")) reasons.push("missing-assignee-avatar");
  if (settings.storyPoints.enabled) {
    if (!visibleWidget(root, ".op-board-ext-sp")) reasons.push("missing-sp");
  }
  if (enrichment.ciSummary && enrichment.ciSummary.total > 0) {
    if (!visibleWidget(root, ".op-board-ext-ci")) reasons.push("missing-ci");
  }
  if (settings.reworkReturns.enabled && enrichment.reworkReturns != null && enrichment.reworkReturns > 0) {
    if (!visibleWidget(root, ".op-board-ext-rework")) reasons.push("missing-rework");
  }
  if (settings.blockers.enabled && enrichment.blockersOk != null) {
    if (!visibleWidget(root, ".op-board-ext-blockers")) reasons.push("missing-blockers");
  }
  if (settings.columnTime.enabled && enrichment.columnTimeText) {
    if (!visibleWidget(root, ".op-board-ext-time")) reasons.push("missing-time");
  }

  // Fingerprint survived on the host but Angular wiped every injected node.
  if (
    reasons.length === 0 &&
    root.hasAttribute("data-op-ext-fp") &&
    !root.querySelector(
      ".op-board-ext-priority, .op-board-ext-assignee-avatar, .op-board-ext-sp, .op-board-ext-ci, .op-board-ext-rework, .op-board-ext-blockers, .op-board-ext-time",
    )
  ) {
    reasons.push("wiped-all");
  }

  return reasons;
}

const WIDGET_PROBE_SELECTORS = [
  "dept-slot:.op-board-ext-dept-slot",
  "priority:.op-board-ext-priority",
  "avatar:.op-board-ext-assignee-avatar",
  "sp:.op-board-ext-sp",
  "ci:.op-board-ext-ci",
  "rework:.op-board-ext-rework",
  "blockers:.op-board-ext-blockers",
  "time:.op-board-ext-time",
  "assignee-row:.op-board-ext-assignee,.op-wp-single-card--content-assignee",
  "content:.op-wp-single-card--content",
] as const;

/** Compact DOM probe for DnD wipe diagnostics (filter console by `op-board-ext:dnd`). */
export function snapshotCardWidgets(root: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {
    tag: root.tagName.toLowerCase(),
    fp: root.getAttribute("data-op-ext-fp")?.slice(0, 24) ?? "none",
    hasExtCard: String(root.classList.contains("op-board-ext-card")),
  };
  for (const entry of WIDGET_PROBE_SELECTORS) {
    const [name, selector] = entry.split(":") as [string, string];
    const el = root.querySelector<HTMLElement>(selector);
    if (!el) {
      out[name] = "missing";
    } else if (el.hidden) {
      out[name] = "hidden";
    } else {
      out[name] = "ok";
    }
  }
  return out;
}

/**
 * True when Angular (or DnD) wiped our injected widgets but the card is still on the board.
 */
export function cardNeedsRestore(
  root: HTMLElement,
  enrichment: CardEnrichment,
  settings: Settings,
): boolean {
  return diagnoseRestoreReasons(root, enrichment, settings).length > 0;
}

function enrichmentFingerprint(enrichment: CardEnrichment, settings: Settings): string {
  return [
    settings.department.enabled ? enrichment.departmentLabel : "",
    settings.priority.enabled
      ? `${enrichment.priorityPosition}:${enrichment.priorityColor}:${enrichment.workPackage.priorityId}`
      : "",
    settings.storyPoints.enabled ? String(enrichment.storyPoints ?? "") : "",
    `${enrichment.workPackage.assigneeId ?? ""}:${enrichment.workPackage.assigneeHref ?? ""}:${enrichment.workPackage.assigneeAvatarUrl ?? ""}`,
    enrichment.ciSummary
      ? `${enrichment.ciSummary.successful}/${enrichment.ciSummary.total}/${enrichment.ciSummary.allSuccessful}`
      : "",
    settings.blockers.enabled ? String(enrichment.blockersOk) : "",
    settings.columnTime.enabled ? enrichment.columnTimeText ?? "" : "",
    settings.reworkReturns.enabled ? String(enrichment.reworkReturns ?? "") : "",
    settings.hideNativeStrip ? "1" : "0",
  ].join("|");
}

function createLightbulbIcon(): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "op-board-ext-sp-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = LIGHTBULB_SVG;
  return icon;
}

function createCiIcon(): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "op-board-ext-ci-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = CI_SVG;
  return icon;
}

function createReworkIcon(): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "op-board-ext-rework-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = REWORK_SVG;
  return icon;
}

const ENTER_CLASS = "op-board-ext-widget-enter";
const SHOWN_ATTR = "data-op-ext-shown";

function clearEnterAnimation(el: HTMLElement): void {
  el.classList.remove(ENTER_CLASS);
  el.style.removeProperty("--op-board-ext-enter-delay");
}

function hideWidget(el: HTMLElement): void {
  el.hidden = true;
  el.removeAttribute(SHOWN_ATTR);
  clearEnterAnimation(el);
}

/** Fade/scale in the first time a widget becomes visible on a card. */
function revealWidget(el: HTMLElement, delayMs = 0): void {
  el.hidden = false;
  if (el.getAttribute(SHOWN_ATTR) === "1") return;
  el.setAttribute(SHOWN_ATTR, "1");
  clearEnterAnimation(el);
  if (delayMs > 0) {
    el.style.setProperty("--op-board-ext-enter-delay", `${delayMs}ms`);
  }
  console.log(`${LOG_RENDER} revealWidget animate`, {
    className: el.className,
    delayMs,
    t: performance.now().toFixed(1),
  });
  // Restart CSS animation even if the class was already present
  void el.offsetWidth;
  el.classList.add(ENTER_CLASS);
  const onEnd = (event: AnimationEvent): void => {
    if (event.target !== el) return;
    clearEnterAnimation(el);
    el.removeEventListener("animationend", onEnd);
  };
  el.addEventListener("animationend", onEnd);
}

const LOG_RENDER = "[op-board-ext:render]";

function paintLazyWidgets(
  card: BoardCard,
  enrichment: CardEnrichment,
  settings: Settings,
  enterDelay: number,
): void {
  // Prefer the already-rendered assignee row — do not resync avatar/priority/SP.
  let assignee = card.root.querySelector<HTMLElement>(".op-board-ext-assignee");
  if (!assignee) {
    assignee = ensureAssigneeRow(card.root, {
      hasAssignee: enrichment.workPackage.assigneeId != null,
      assigneeName: enrichment.workPackage.assigneeName,
      assigneeAvatarUrl: enrichment.workPackage.assigneeAvatarUrl,
    });
  }

  if (assignee) {
    const ci = ensureCiSlot(assignee);
    const ciSummary = enrichment.ciSummary;
    if (ciSummary && ciSummary.total > 0) {
      ci.title =
        ciSummary.pullRequestCount > 1
          ? `CI: ${ciSummary.successful}/${ciSummary.total} успешных этапов по ${ciSummary.pullRequestCount} PR`
          : `CI: ${ciSummary.successful}/${ciSummary.total} успешных этапов`;
      ci.className = ciSummary.allSuccessful
        ? "op-board-ext-ci op-board-ext-ci--ok"
        : "op-board-ext-ci op-board-ext-ci--failed";
      // Avoid DOM thrash if content unchanged
      const nextText = `${ciSummary.successful}/${ciSummary.total}`;
      const valueEl = ci.querySelector(".op-board-ext-ci-value");
      if (!valueEl || valueEl.textContent !== nextText || ci.getAttribute(SHOWN_ATTR) !== "1") {
        ci.replaceChildren();
        const num = document.createElement("span");
        num.className = "op-board-ext-ci-value";
        num.textContent = nextText;
        ci.append(createCiIcon(), num);
      }
      revealWidget(ci, enterDelay + 80);
    } else {
      ci.replaceChildren();
      hideWidget(ci);
    }

    const rework = ensureReworkSlot(assignee);
    const reworkCount =
      settings.reworkReturns.enabled && enrichment.reworkReturns != null && enrichment.reworkReturns > 0
        ? enrichment.reworkReturns
        : null;
    if (reworkCount != null) {
      const severity = reworkSeverity(reworkCount);
      rework.className = `op-board-ext-rework op-board-ext-rework--${severity}`;
      rework.title =
        reworkCount === 1
          ? "1 возврат из готово в доработку"
          : `Возвратов из готово в доработку: ${reworkCount}`;
      const valueEl = rework.querySelector(".op-board-ext-rework-value");
      if (!valueEl || valueEl.textContent !== String(reworkCount) || rework.getAttribute(SHOWN_ATTR) !== "1") {
        rework.replaceChildren();
        const num = document.createElement("span");
        num.className = "op-board-ext-rework-value";
        num.textContent = String(reworkCount);
        rework.append(createReworkIcon(), num);
      }
      revealWidget(rework, enterDelay + 100);
    } else {
      rework.replaceChildren();
      hideWidget(rework);
    }
  }

  const blockers = ensureBlockersSlot(card.root);
  if (settings.blockers.enabled && enrichment.blockersOk != null) {
    const nextClass = enrichment.blockersOk
      ? "op-board-ext-blockers op-board-ext-blockers--ok"
      : "op-board-ext-blockers op-board-ext-blockers--blocked";
    const nextText = enrichment.blockersOk ? "✓" : "✕";
    blockers.className = nextClass;
    if (blockers.textContent !== nextText) blockers.textContent = nextText;
    blockers.title = enrichment.blockersOk
      ? "Все связанные задачи выполнены (или связей нет)"
      : "Есть незавершённые связанные задачи";
    revealWidget(blockers, enterDelay + 60);
    getCardSurface(card.root).classList.add("op-board-ext-has-blockers");
  } else {
    blockers.textContent = "";
    hideWidget(blockers);
    getCardSurface(card.root).classList.remove("op-board-ext-has-blockers");
  }

  const time = ensureTimeSlot(card.root);
  if (settings.columnTime.enabled && enrichment.columnTimeText) {
    time.className = "op-board-ext-time";
    if (time.textContent !== enrichment.columnTimeText) {
      time.textContent = enrichment.columnTimeText;
    }
    time.title = `В колонке: ${enrichment.workPackage.statusName}`;
    revealWidget(time, enterDelay + 100);
  } else {
    time.textContent = "";
    hideWidget(time);
  }
}

export function renderCard(
  card: BoardCard,
  enrichment: CardEnrichment | undefined,
  settings: Settings,
  options?: { enterDelayMs?: number; force?: boolean; reason?: string; lazyOnly?: boolean },
): void {
  markCard(card.root, card.workPackageId);
  card.root.classList.add("op-board-ext-card");
  getCardSurface(card.root).classList.add("op-board-ext-surface");
  cleanupLegacyNodes(card.root);

  if (!enrichment) return;

  const enterDelay = options?.enterDelayMs ?? 0;
  const fp = enrichmentFingerprint(enrichment, settings);
  const prevFp = getRenderFingerprint(card.root);
  const restoreReasons = diagnoseRestoreReasons(card.root, enrichment, settings);
  const fpMatch = prevFp === fp;

  // Lazy tier: only paint CI / blockers / time / rework — do not rewrite priority/avatar/SP.
  if (options?.lazyOnly) {
    const coreMissing = restoreReasons.some(
      (r) =>
        r === "missing-priority" ||
        r === "missing-assignee-avatar" ||
        r === "missing-sp" ||
        r === "missing-dept-slot",
    );
    if (coreMissing) {
      console.log(`${LOG_RENDER} lazyOnly → full paint #${card.workPackageId}`, {
        restoreReasons,
        t: performance.now().toFixed(1),
      });
      // Fall through to full paint below
    } else {
      console.log(`${LOG_RENDER} lazyOnly paint #${card.workPackageId}`, {
        reason: options.reason ?? "lazyOnly",
        t: performance.now().toFixed(1),
      });
      paintLazyWidgets(card, enrichment, settings, enterDelay);
      setRenderFingerprint(card.root, fp);
      return;
    }
  }

  if (!options?.force && !options?.lazyOnly && fpMatch && restoreReasons.length === 0) {
    console.log(`${LOG_RENDER} skip #${card.workPackageId}`, {
      reason: options?.reason ?? "unspecified",
      fpMatch,
    });
    return;
  }

  console.log(`${LOG_RENDER} paint #${card.workPackageId}`, {
    reason: options?.reason ?? "unspecified",
    force: Boolean(options?.force),
    lazyOnly: Boolean(options?.lazyOnly),
    enterDelayMs: enterDelay,
    fpMatch,
    fpChanged: !fpMatch,
    restoreReasons,
    t: performance.now().toFixed(1),
  });

  applyDepartmentAfterId(card.root, enrichment.departmentLabel, settings.department.enabled);
  const deptSlot = card.root.querySelector<HTMLElement>(
    ".op-wp-single-card--content-project-name.op-board-ext-dept-slot",
  );
  if (deptSlot && settings.department.enabled && enrichment.departmentLabel) {
    revealWidget(deptSlot, enterDelay);
  }

  const assignee = ensureAssigneeRow(card.root, {
    hasAssignee: enrichment.workPackage.assigneeId != null,
    assigneeName: enrichment.workPackage.assigneeName,
    assigneeAvatarUrl: enrichment.workPackage.assigneeAvatarUrl,
  });
  if (assignee) {
    assignee.dataset.workPackageId = String(card.workPackageId);
    assignee.classList.add("op-board-ext-assignee--editable");
    assignee.title = enrichment.workPackage.assigneeName
      ? `Исполнитель: ${enrichment.workPackage.assigneeName}`
      : "Назначить исполнителя";

    const priority = ensurePrioritySlot(assignee);
    if (settings.priority.enabled && enrichment.priorityPosition != null) {
      priority.dataset.workPackageId = String(card.workPackageId);
      priority.textContent = formatPriorityLabel(enrichment.priorityPosition);
      priority.title = enrichment.workPackage.priorityName;
      const bg = enrichment.priorityColor || "#9e9e9e";
      priority.style.backgroundColor = bg;
      priority.style.color = contrastTextColor(bg);
      priority.classList.add("op-board-ext-priority--editable");
      revealWidget(priority, enterDelay);
    } else {
      priority.textContent = "";
      hideWidget(priority);
    }

    const sp = ensureSpSlot(assignee);
    if (settings.storyPoints.enabled) {
      const spValue = formatSpValue(enrichment.storyPoints);
      const display = spValue ?? "-";
      sp.dataset.workPackageId = String(card.workPackageId);
      sp.title = spValue ? `Story Points: ${spValue}` : "Указать Story Points";
      sp.classList.add("op-board-ext-sp--editable");
      sp.classList.toggle("op-board-ext-sp--empty", spValue == null);
      sp.replaceChildren();
      const num = document.createElement("span");
      num.className = "op-board-ext-sp-value";
      num.textContent = display;
      sp.append(createLightbulbIcon(), num);
      revealWidget(sp, enterDelay + 40);
    } else {
      sp.replaceChildren();
      hideWidget(sp);
    }
  }

  paintLazyWidgets(card, enrichment, settings, enterDelay);

  setRenderFingerprint(card.root, fp);

  const after = diagnoseRestoreReasons(card.root, enrichment, settings);
  if (after.length > 0) {
    console.warn(`${LOG_RENDER} paint incomplete #${card.workPackageId}`, {
      reason: options?.reason ?? "unspecified",
      stillMissing: after,
      widgets: snapshotCardWidgets(card.root),
      assigneeCreated: Boolean(assignee),
      t: performance.now().toFixed(1),
    });
  } else {
    console.log(`${LOG_RENDER} paint ok #${card.workPackageId}`, {
      reason: options?.reason ?? "unspecified",
      widgets: snapshotCardWidgets(card.root),
      t: performance.now().toFixed(1),
    });
  }
}

export function teardownCard(root: HTMLElement): void {
  cleanupLegacyNodes(root);
  root
    .querySelectorAll(
      ".op-board-ext-dept, .op-board-ext-priority, .op-board-ext-sp, .op-board-ext-ci, .op-board-ext-rework, .op-board-ext-blockers, .op-board-ext-time, .op-board-ext-assignee-row, .op-board-ext-assignee-placeholder, .op-board-ext-assignee-avatar",
    )
    .forEach((el) => el.remove());
  root.querySelectorAll(".op-board-ext-hide-project, .op-board-ext-dept-slot").forEach((el) => {
    el.classList.remove("op-board-ext-hide-project", "op-board-ext-dept-slot");
  });
  root.classList.remove("op-board-ext-card");
  root.removeAttribute("data-op-ext-fp");
  const surface = getCardSurface(root);
  surface.classList.remove("op-board-ext-surface", "op-board-ext-has-blockers");
}
