/**
 * The two questions about the window the CSS cannot answer, asked in one place.
 *
 * The height one is the keyboard. No viewport unit follows an on-screen keyboard: iOS Safari never resizes
 * the layout viewport for it, and Chrome's `interactive-widget` default resizes only the visual viewport —
 * so `dvh` describes the page with the keyboard down, and a form field focused near the bottom slides under
 * it. `visualViewport.height` is the number that does follow, so when it is at least `KEYBOARD_MIN` shorter
 * than the window (a keyboard, not the URL bar that `dvh` already tracks) the page publishes it as
 * `--flypi-vh` and `ui/app.css` lays the page out on that. Without this script the fallback is `100dvh`:
 * the phone page still works, it just cannot dodge the keyboard.
 *
 * The width one is the layout breakpoint. It is only a query, and the component must act on both sides of
 * it — the drawer closes when the page grows out of the phone layout — so it is exposed as an event rather
 * than duplicated as a second `matchMedia` in the component.
 */
export const MOBILE_QUERY = "(max-width: 56rem)";

/** A keyboard is at least this much taller than the chrome a phone hides and shows while scrolling. */
export const KEYBOARD_MIN = 120;

/**
 * The height to lay the page out on, or `null` to let the CSS `100dvh` fallback rule. Rounded: the point
 * is a stable number to set, not sub-pixel fidelity.
 */
export function appHeight(inner: number, visual: number | undefined): number | null {
	if (visual === undefined || !Number.isFinite(visual) || visual <= 0) return null;
	return inner - visual >= KEYBOARD_MIN ? Math.round(visual) : null;
}

/**
 * Publish `--flypi-vh` while a keyboard is up, and take it away again when it closes. Returns the cleanup
 * so the page's one caller (ui/main.ts) can tear it down; the listeners cover both the layout resizing
 * (Android's `resizes-content`, rotations) and the visual viewport moving (the keyboard itself).
 */
export function trackAppHeight(): () => void {
	const root = document.documentElement;
	const viewport = window.visualViewport;
	const apply = () => {
		const height = appHeight(window.innerHeight, viewport?.height);
		if (height === null) root.style.removeProperty("--flypi-vh");
		else root.style.setProperty("--flypi-vh", `${height}px`);
	};
	apply();
	window.addEventListener("resize", apply);
	viewport?.addEventListener("resize", apply);
	return () => {
		window.removeEventListener("resize", apply);
		viewport?.removeEventListener("resize", apply);
	};
}

/** Run `cb` whenever the page crosses the layout breakpoint; returns the cleanup. */
export function onBreakpointChange(cb: (mobile: boolean) => void): () => void {
	const query = window.matchMedia(MOBILE_QUERY);
	const handler = () => cb(query.matches);
	query.addEventListener("change", handler);
	return () => query.removeEventListener("change", handler);
}
