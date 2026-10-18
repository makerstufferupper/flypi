/**
 * Light/dark is a `data-theme` attribute on <html> and nothing else: app.css holds both palettes as
 * custom properties. The choice is the page's, not the server's, so it lives in localStorage.
 */
export type Theme = "light" | "dark";

const KEY = "flypi.theme";

export function currentTheme(): Theme | null {
	const value = document.documentElement.dataset.theme;
	return value === "light" || value === "dark" ? value : null;
}

/** Default to the OS, then remember an explicit choice. */
export function setTheme(theme: Theme): void {
	document.documentElement.dataset.theme = theme;
	try {
		localStorage.setItem(KEY, theme);
	} catch {
		// Private mode: the theme lasts as long as the tab, which is fine.
	}
}

export function initTheme(): void {
	const saved = localStorage.getItem(KEY);
	setTheme(saved === "light" || saved === "dark" ? saved : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
