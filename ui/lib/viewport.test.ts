/**
 * The keyboard height and the layout breakpoint (ui/lib/viewport.ts): the two window facts the CSS cannot
 * read. `appHeight` is pure so the thresholds are asserted without a viewport; the tracking is asserted
 * against a stubbed `visualViewport`, which is the only way a headless browser can pose as a phone with the
 * keyboard up.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { appHeight, KEYBOARD_MIN, MOBILE_QUERY, onBreakpointChange, trackAppHeight } from "./viewport.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.documentElement.style.removeProperty("--flypi-vh");
});

describe("appHeight", () => {
	it("has no answer without a visual viewport", () => {
		expect(appHeight(844, undefined)).toBeNull();
		expect(appHeight(844, Number.NaN)).toBeNull();
		expect(appHeight(844, 0)).toBeNull();
	});

	it("ignores the URL bar the browser hides and shows", () => {
		// `dvh` already follows this; only a real keyboard is worth overriding the layout height for.
		expect(appHeight(844, 844)).toBeNull();
		expect(appHeight(844, 844 - 60)).toBeNull();
		expect(appHeight(844, 844 - KEYBOARD_MIN + 1)).toBeNull();
	});

	it("reports the usable height while a keyboard is up", () => {
		expect(appHeight(844, 844 - KEYBOARD_MIN)).toBe(844 - KEYBOARD_MIN);
		expect(appHeight(844, 544)).toBe(544);
	});
});

describe("trackAppHeight", () => {
	/** A visual viewport whose height can be moved, and nothing else — we only listen for `resize`. */
	function fakeViewport(height: number) {
		const listeners = new Set<() => void>();
		const viewport = {
			height,
			addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
			removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
		};
		return { viewport, listeners };
	}

	it("publishes --flypi-vh while the keyboard is up and takes it away when it closes", async () => {
		const { viewport, listeners } = fakeViewport(544);
		const inner = vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
		Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });

		const stop = trackAppHeight();
		expect(document.documentElement.style.getPropertyValue("--flypi-vh")).toBe("544px");

		// The keyboard goes away: the URL bar's 60px is not a keyboard, so the CSS fallback rules.
		viewport.height = 784;
		for (const listener of listeners) listener();
		expect(document.documentElement.style.getPropertyValue("--flypi-vh")).toBe("");

		viewport.height = 544;
		for (const listener of listeners) listener();
		expect(document.documentElement.style.getPropertyValue("--flypi-vh")).toBe("544px");

		stop();
		expect(listeners.size).toBe(0);
		inner.mockRestore();
	});

	it("works with no visual viewport at all", () => {
		Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
		const stop = trackAppHeight();
		expect(document.documentElement.style.getPropertyValue("--flypi-vh")).toBe("");
		stop();
	});
});

describe("onBreakpointChange", () => {
	it("reports both sides of the layout breakpoint and unsubscribes on cleanup", () => {
		type Listener = (event: { matches: boolean }) => void;
		const listeners = new Set<Listener>();
		const query = { matches: false, addEventListener: (_t: string, listener: Listener) => listeners.add(listener), removeEventListener: (_t: string, listener: Listener) => listeners.delete(listener) };
		const asked: string[] = [];
		vi.stubGlobal("matchMedia", (media: string) => {
			asked.push(media);
			return query;
		});

		const seen: boolean[] = [];
		const stop = onBreakpointChange((mobile) => seen.push(mobile));
		expect(asked).toEqual([MOBILE_QUERY]);

		query.matches = true;
		for (const listener of listeners) listener({ matches: true });
		query.matches = false;
		for (const listener of listeners) listener({ matches: false });
		expect(seen).toEqual([true, false]);

		stop();
		expect(listeners.size).toBe(0);
	});
});
