/**
 * Theme is a `data-theme` attribute and a localStorage key — that is the whole feature, so the test
 * is that both move together, including what a fresh page picks up.
 */
import { afterEach, describe, expect, it } from "vitest";
import { currentTheme, initTheme, setTheme } from "./theme.ts";

afterEach(() => {
	localStorage.clear();
	delete document.documentElement.dataset.theme;
});

describe("theme", () => {
	it("sets the attribute and remembers the choice", () => {
		setTheme("dark");
		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(localStorage.getItem("flypi.theme")).toBe("dark");
		expect(currentTheme()).toBe("dark");
	});

	it("a fresh page has no theme until it is initialised", () => {
		expect(currentTheme()).toBeNull();
	});

	it("initialising keeps a saved choice", () => {
		localStorage.setItem("flypi.theme", "dark");
		initTheme();
		expect(document.documentElement.dataset.theme).toBe("dark");
	});

	it("initialising falls back to what the OS prefers", () => {
		globalThis.matchMedia = () => ({ matches: true }) as MediaQueryList;
		initTheme();
		expect(document.documentElement.dataset.theme).toBe("dark");
		localStorage.clear(); // the first call remembered; this one is a fresh page again
		globalThis.matchMedia = () => ({ matches: false }) as MediaQueryList;
		initTheme();
		expect(document.documentElement.dataset.theme).toBe("light");
	});
});
