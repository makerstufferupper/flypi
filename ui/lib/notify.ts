/**
 * Desktop notifications for a turn that finished while you were somewhere else.
 *
 * Browser-only, and its permission can only be asked for from a user gesture — so this lives apart from
 * the app state (which stays DOM-free) and the bell in the sidebar is what asks. The *preference* is a
 * page setting like the theme; the *permission* belongs to the browser and cannot be granted from here.
 *
 * Every negative outcome (no Notification API, permission denied, the user turned it off, a platform whose
 * notification daemon refuses to construct one) is an ordinary state: it returns undefined instead of
 * throwing, because a finished turn must never fail because a toast could not be shown.
 */
export type NotificationState = "granted" | "denied" | "default" | "unsupported";

const PREFERENCE = "flypi.notifications";

export function notificationsSupported(): boolean {
	return typeof Notification !== "undefined";
}

export function notificationState(): NotificationState {
	return notificationsSupported() ? Notification.permission : "unsupported";
}

/** Whether the user wants them — a preference, independent of what the browser allows. */
export function wantsNotifications(): boolean {
	try {
		return localStorage.getItem(PREFERENCE) !== "off";
	} catch {
		// Storage disabled: the default is on, which is what the permission prompt decides anyway.
		return true;
	}
}

export function setWantsNotifications(wanted: boolean): void {
	try {
		localStorage.setItem(PREFERENCE, wanted ? "on" : "off");
	} catch {
		// The choice just will not survive a reload; the permission is still the browser's.
	}
}

/** Ask the browser. Call from a click or keypress: a page that asks on load is refused or ignored. */
export async function requestNotifications(): Promise<NotificationState> {
	if (!notificationsSupported()) return "unsupported";
	if (Notification.permission !== "default") return Notification.permission;
	try {
		return await Notification.requestPermission();
	} catch {
		return Notification.permission;
	}
}

/**
 * The last notice this page put up. Some browsers drop a notification whose JS object is collected before
 * it is read, so the page keeps one alive; the next replaces it (the OS keeps the one already shown).
 */
let lastShown: Notification | undefined;

export interface TurnNotice {
	title: string;
	body: string;
	/** Replaces an earlier notice for the same session instead of stacking a second one. */
	tag: string;
	onClick?: () => void;
}

/**
 * Show a finished turn, or say nothing when notifications are unavailable, refused or turned off.
 * Clicking it focuses the window and runs `onClick`, which is how the page opens that session.
 */
export function notifyTurnDone(notice: TurnNotice): Notification | undefined {
	if (!notificationsSupported() || Notification.permission !== "granted" || !wantsNotifications()) return undefined;
	try {
		const shown = new Notification(notice.title, { body: notice.body, tag: notice.tag });
		lastShown = shown;
		shown.onclick = () => {
			window.focus();
			notice.onClick?.();
			shown.close();
		};
		return shown;
	} catch (error) {
		// A platform that refuses to construct one (no notification daemon, a browser policy). Say so in the
		// dev console rather than failing silently, because "nothing appeared" is otherwise undiagnosable.
		console.warn(`flypi: desktop notification failed: ${(error as Error).message}`);
		return undefined;
	}
}
