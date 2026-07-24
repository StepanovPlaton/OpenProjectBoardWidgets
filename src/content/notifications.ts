import { sendMessage } from "../shared/messaging";
import { notificationReasonLabel } from "../shared/api/notifications";
import type {
  BackgroundResponse,
  CardNotificationBadge,
  NotificationSummary,
  Settings,
} from "../shared/types";
import { findBoardCards, getCardSurface } from "./cards";

const LOG = "[op-board-ext]";
const POLL_MS = 30_000;
const TOAST_MS = 10_000;
const BADGE_CLASS = "op-board-ext-notif";
const TOAST_HOST_ID = "op-board-ext-notif-toasts";

let settingsGetter: () => Settings | null = () => null;
let started = false;
let pollTimer: number | null = null;
let syncTimer: number | null = null;
let unread: NotificationSummary[] = [];
const knownIds = new Set<number>();
let primed = false;
let markInFlight: number | null = null;

function enabled(): boolean {
  return settingsGetter()?.notifications.enabled !== false;
}

function badgeForWp(workPackageId: number): CardNotificationBadge {
  const related = unread.filter((n) => n.workPackageId === workPackageId && !n.readIAN);
  if (related.length === 0) return "none";
  if (related.some((n) => n.reason === "mentioned")) return "mention";
  return "unread";
}

function ensureBadgeSlot(root: HTMLElement): HTMLElement {
  const surface = getCardSurface(root);
  surface.classList.add("op-board-ext-surface");
  let el = surface.querySelector<HTMLElement>(`:scope > .${BADGE_CLASS}`);
  if (!el) {
    el = document.createElement("span");
    el.className = BADGE_CLASS;
    el.setAttribute("aria-hidden", "true");
    surface.appendChild(el);
  }
  return el;
}

export function applyNotificationBadges(): void {
  if (!enabled()) {
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
    return;
  }

  for (const card of findBoardCards()) {
    const kind = badgeForWp(card.workPackageId);
    const badge = ensureBadgeSlot(card.root);
    if (kind === "none") {
      badge.hidden = true;
      badge.textContent = "";
      badge.className = BADGE_CLASS;
      continue;
    }

    badge.hidden = false;
    if (kind === "mention") {
      badge.className = `${BADGE_CLASS} ${BADGE_CLASS}--mention`;
      badge.textContent = "@";
      badge.title = "Вас упомянули в этой задаче";
    } else {
      badge.className = `${BADGE_CLASS} ${BADGE_CLASS}--unread`;
      badge.textContent = "";
      badge.title = "Есть непрочитанные уведомления";
    }
  }
}

function ensureToastHost(): HTMLElement {
  let host = document.getElementById(TOAST_HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = TOAST_HOST_ID;
    document.documentElement.appendChild(host);
  }
  return host;
}

function showToast(notification: NotificationSummary): void {
  const host = ensureToastHost();
  const toast = document.createElement("article");
  toast.className = "op-board-ext-notif-toast";
  toast.setAttribute("role", "status");

  const reason = document.createElement("div");
  reason.className = "op-board-ext-notif-toast-reason";
  reason.textContent = notification.subject?.trim() || notificationReasonLabel(notification.reason);

  const task = document.createElement("div");
  task.className = "op-board-ext-notif-toast-task";
  task.textContent = notification.workPackageSubject
    ? `#${notification.workPackageId ?? "?"} ${notification.workPackageSubject}`
    : notification.workPackageId
      ? `Задача #${notification.workPackageId}`
      : "Задача";

  const meta = document.createElement("div");
  meta.className = "op-board-ext-notif-toast-meta";
  const parts = [notification.projectName, notification.actorName].filter(Boolean);
  meta.textContent = parts.join(" · ");

  const close = document.createElement("button");
  close.type = "button";
  close.className = "op-board-ext-notif-toast-close";
  close.setAttribute("aria-label", "Закрыть");
  close.textContent = "×";
  close.addEventListener("click", () => toast.remove());

  toast.append(close, reason, task);
  if (parts.length > 0) toast.append(meta);
  host.prepend(toast);

  window.setTimeout(() => {
    toast.classList.add("op-board-ext-notif-toast--out");
    window.setTimeout(() => toast.remove(), 280);
  }, TOAST_MS);
}

function parseWorkPackageId(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/&quot;/gi, "").replace(/["']/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getOpenWorkPackageId(): number | null {
  // URL is the source of truth for board split view, including /details/:id/activity
  const pathMatch = location.pathname.match(/\/(?:details|work_packages)\/(\d+)(?:\/|$)/i);
  if (pathMatch) {
    const id = Number(pathMatch[1]);
    if (Number.isFinite(id) && id > 0) return id;
  }

  const splitView = document.querySelector<HTMLElement>(
    "opce-wp-split-view[data-work-package-id], [data-work-package-id]",
  );
  const fromAttr = parseWorkPackageId(splitView?.getAttribute("data-work-package-id"));
  if (fromAttr != null) return fromAttr;

  return null;
}

async function fetchUnread(): Promise<NotificationSummary[]> {
  const response = await sendMessage<BackgroundResponse>({ type: "GET_UNREAD_NOTIFICATIONS" });
  if (!response.ok || !("notifications" in response)) {
    throw new Error(!response.ok ? response.error : "No notifications payload");
  }
  return response.notifications;
}

function ingestNotifications(next: NotificationSummary[], announceNew: boolean): void {
  const incoming = next.filter((n) => !n.readIAN);
  if (announceNew && primed) {
    const fresh = incoming
      .filter((n) => !knownIds.has(n.id))
      .sort((a, b) => {
        const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
        const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
        return ta - tb;
      });
    for (const n of fresh) {
      showToast(n);
    }
  }

  unread = incoming;
  knownIds.clear();
  for (const n of unread) knownIds.add(n.id);
  primed = true;
  applyNotificationBadges();
}

async function syncNotifications(announceNew: boolean): Promise<void> {
  if (!enabled()) {
    unread = [];
    applyNotificationBadges();
    return;
  }
  if (!settingsGetter()?.connection.token?.trim()) return;

  try {
    const next = await fetchUnread();
    ingestNotifications(next, announceNew);
    await maybeMarkOpenTaskRead();
  } catch (error) {
    console.warn(`${LOG} notifications sync failed`, error);
  }
}

async function maybeMarkOpenTaskRead(): Promise<void> {
  if (!enabled()) return;
  const wpId = getOpenWorkPackageId();
  if (wpId == null) return;

  const related = unread.filter((n) => n.workPackageId === wpId && !n.readIAN);
  if (related.length === 0) return;
  if (markInFlight === wpId) return;

  markInFlight = wpId;
  const relatedIds = related.map((n) => n.id);

  console.log(`${LOG} sending MARK_WP_NOTIFICATIONS_READ`, {
    workPackageId: wpId,
    notificationIds: relatedIds,
    href: location.href,
  });

  try {
    const response = await sendMessage<BackgroundResponse>({
      type: "MARK_WP_NOTIFICATIONS_READ",
      workPackageId: wpId,
      notificationIds: relatedIds,
    });
    if (response.ok && "notifications" in response) {
      ingestNotifications(response.notifications, false);
      console.log(`${LOG} mark-as-read response ok`, {
        workPackageId: wpId,
        remainingUnread: response.notifications.filter((n) => n.workPackageId === wpId).length,
      });
    } else if (!response.ok) {
      console.warn(`${LOG} mark notifications read failed`, response.error, response.code);
    }
  } catch (error) {
    console.warn(`${LOG} mark notifications read failed`, error);
  } finally {
    markInFlight = null;
  }
}

function scheduleOpenTaskCheck(): void {
  if (syncTimer != null) window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    void maybeMarkOpenTaskRead();
    applyNotificationBadges();
  }, 80);
}

function startPolling(): void {
  if (pollTimer != null) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    void syncNotifications(true);
  }, POLL_MS);
}

export function initNotifications(getSettings: () => Settings | null): void {
  settingsGetter = getSettings;
  if (started) {
    void syncNotifications(false);
    return;
  }
  started = true;

  void syncNotifications(false);
  startPolling();

  let lastHref = location.href;
  const onRouteMaybeChanged = (): void => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      console.log(`${LOG} route changed`, { href: location.href, openWp: getOpenWorkPackageId() });
    }
    scheduleOpenTaskCheck();
  };

  const observer = new MutationObserver(() => {
    onRouteMaybeChanged();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-work-package-id", "data-active-tab", "class"],
  });

  window.addEventListener("popstate", onRouteMaybeChanged);
  window.addEventListener("hashchange", onRouteMaybeChanged);

  // OpenProject uses pushState heavily — wrap even if already wrapped
  const wrapHistory = (method: "pushState" | "replaceState"): void => {
    const original = history[method].bind(history);
    history[method] = ((...args: Parameters<History["pushState"]>) => {
      const result = original(...args);
      onRouteMaybeChanged();
      return result;
    }) as History["pushState"];
  };
  wrapHistory("pushState");
  wrapHistory("replaceState");

  // Fallback: catch SPA navigations that bypass history hooks
  window.setInterval(() => {
    if (location.href !== lastHref) onRouteMaybeChanged();
  }, 1000);
}

export function refreshNotifications(announceNew = false): void {
  void syncNotifications(announceNew);
}

export function refreshNotificationBadgesOnly(): void {
  applyNotificationBadges();
}
