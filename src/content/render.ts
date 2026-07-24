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

/**
 * True when Angular (or DnD) wiped our injected widgets but the card is still on the board.
 */
export function cardNeedsRestore(
  root: HTMLElement,
  enrichment: CardEnrichment,
  settings: Settings,
): boolean {
  if (settings.department.enabled && enrichment.departmentLabel) {
    if (!root.querySelector(".op-board-ext-dept-slot")) return true;
  }
  if (settings.priority.enabled && enrichment.priorityPosition != null) {
    if (!visibleWidget(root, ".op-board-ext-priority")) return true;
  }
  if (settings.storyPoints.enabled && enrichment.storyPoints != null) {
    if (!visibleWidget(root, ".op-board-ext-sp")) return true;
  }
  if (enrichment.ciSummary && enrichment.ciSummary.total > 0) {
    if (!visibleWidget(root, ".op-board-ext-ci")) return true;
  }
  if (settings.reworkReturns.enabled && enrichment.reworkReturns != null && enrichment.reworkReturns > 0) {
    if (!visibleWidget(root, ".op-board-ext-rework")) return true;
  }
  if (settings.blockers.enabled && enrichment.blockersOk != null) {
    if (!visibleWidget(root, ".op-board-ext-blockers")) return true;
  }
  if (settings.columnTime.enabled && enrichment.columnTimeText) {
    if (!visibleWidget(root, ".op-board-ext-time")) return true;
  }
  return false;
}

function enrichmentFingerprint(enrichment: CardEnrichment, settings: Settings): string {
  return [
    settings.department.enabled ? enrichment.departmentLabel : "",
    settings.priority.enabled ? `${enrichment.priorityPosition}:${enrichment.priorityColor}` : "",
    settings.storyPoints.enabled ? String(enrichment.storyPoints ?? "") : "",
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

export function renderCard(
  card: BoardCard,
  enrichment: CardEnrichment | undefined,
  settings: Settings,
  options?: { enterDelayMs?: number; force?: boolean },
): void {
  markCard(card.root, card.workPackageId);
  card.root.classList.add("op-board-ext-card");
  getCardSurface(card.root).classList.add("op-board-ext-surface");
  cleanupLegacyNodes(card.root);

  if (!enrichment) return;

  const enterDelay = options?.enterDelayMs ?? 0;
  const fp = enrichmentFingerprint(enrichment, settings);
  if (!options?.force && getRenderFingerprint(card.root) === fp) {
    // Still ensure dept/slots exist if Angular wiped them, but skip full rewrite when same
    if (!cardNeedsRestore(card.root, enrichment, settings)) {
      return;
    }
  }

  applyDepartmentAfterId(card.root, enrichment.departmentLabel, settings.department.enabled);
  const deptSlot = card.root.querySelector<HTMLElement>(
    ".op-wp-single-card--content-project-name.op-board-ext-dept-slot",
  );
  if (deptSlot && settings.department.enabled && enrichment.departmentLabel) {
    revealWidget(deptSlot, enterDelay);
  }

  const assignee = ensureAssigneeRow(card.root);
  if (assignee) {
    const priority = ensurePrioritySlot(assignee);
    if (settings.priority.enabled && enrichment.priorityPosition != null) {
      priority.textContent = formatPriorityLabel(enrichment.priorityPosition);
      priority.title = enrichment.workPackage.priorityName;
      const bg = enrichment.priorityColor || "#9e9e9e";
      priority.style.backgroundColor = bg;
      priority.style.color = contrastTextColor(bg);
      revealWidget(priority, enterDelay);
    } else {
      priority.textContent = "";
      hideWidget(priority);
    }

    const sp = ensureSpSlot(assignee);
    const spValue = settings.storyPoints.enabled ? formatSpValue(enrichment.storyPoints) : null;
    if (spValue) {
      sp.title = `Story Points: ${spValue}`;
      sp.replaceChildren();
      const num = document.createElement("span");
      num.className = "op-board-ext-sp-value";
      num.textContent = spValue;
      sp.append(createLightbulbIcon(), num);
      revealWidget(sp, enterDelay + 40);
    } else {
      sp.replaceChildren();
      hideWidget(sp);
    }

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
      ci.replaceChildren();
      const num = document.createElement("span");
      num.className = "op-board-ext-ci-value";
      num.textContent = `${ciSummary.successful}/${ciSummary.total}`;
      ci.append(createCiIcon(), num);
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
      rework.replaceChildren();
      const num = document.createElement("span");
      num.className = "op-board-ext-rework-value";
      num.textContent = String(reworkCount);
      rework.append(createReworkIcon(), num);
      revealWidget(rework, enterDelay + 100);
    } else {
      rework.replaceChildren();
      hideWidget(rework);
    }
  }

  const blockers = ensureBlockersSlot(card.root);
  if (settings.blockers.enabled && enrichment.blockersOk != null) {
    blockers.className = enrichment.blockersOk
      ? "op-board-ext-blockers op-board-ext-blockers--ok"
      : "op-board-ext-blockers op-board-ext-blockers--blocked";
    blockers.textContent = enrichment.blockersOk ? "✓" : "✕";
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
    time.textContent = enrichment.columnTimeText;
    time.title = `В колонке: ${enrichment.workPackage.statusName}`;
    revealWidget(time, enterDelay + 100);
  } else {
    time.textContent = "";
    hideWidget(time);
  }

  setRenderFingerprint(card.root, fp);
}

export function teardownCard(root: HTMLElement): void {
  cleanupLegacyNodes(root);
  root
    .querySelectorAll(
      ".op-board-ext-dept, .op-board-ext-priority, .op-board-ext-sp, .op-board-ext-ci, .op-board-ext-rework, .op-board-ext-blockers, .op-board-ext-time",
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
