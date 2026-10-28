/**
 * The two resizable columns are the page's own setting, exactly like the theme (ui/lib/theme.ts):
 * a choice you make once and expect to keep, so it lives in localStorage and never crosses the
 * socket. Widths are in rem, the unit the layout is written in.
 *
 * The activity sheet's open state is kept the same way — a panel you left open should still be open after
 * a reload — but it is a phone-only surface, so on a desktop it is simply never read (`ui/app.css`).
 */
export type Panel = "sidebar" | "activity";

const LIMITS: Record<Panel, { min: number; max: number; fallback: number }> = {
	sidebar: { min: 11, max: 34, fallback: 15 },
	activity: { min: 14, max: 40, fallback: 22 },
};

export function limits(panel: Panel): { min: number; max: number } {
	return LIMITS[panel];
}

export function loadWidth(panel: Panel): number {
	const stored = localStorage.getItem(`flypi.${panel}Width`);
	// Number(null) is 0, which would silently mean "minimum width" instead of the default.
	const saved = stored === null ? Number.NaN : Number(stored);
	return Number.isFinite(saved) ? clampWidth(panel, saved) : LIMITS[panel].fallback;
}

/** Quarter-rem steps: a drag lands on whole pixels at the default 16px root size. */
export function clampWidth(panel: Panel, rem: number): number {
	const { min, max } = LIMITS[panel];
	return Math.min(max, Math.max(min, Math.round(rem * 4) / 4));
}

export function saveWidth(panel: Panel, rem: number): void {
	try {
		localStorage.setItem(`flypi.${panel}Width`, String(clampWidth(panel, rem)));
	} catch {
		// Private mode: the width lasts as long as the tab, which is fine.
	}
}

/** Whether the activity sheet was left open on the last visit. */
export function loadSheet(): boolean {
	try {
		return localStorage.getItem("flypi.sheetOpen") === "1";
	} catch {
		return false;
	}
}

export function saveSheet(open: boolean): void {
	try {
		localStorage.setItem("flypi.sheetOpen", open ? "1" : "0");
	} catch {
		// Private mode: the sheet lasts as long as the tab, which is fine.
	}
}
