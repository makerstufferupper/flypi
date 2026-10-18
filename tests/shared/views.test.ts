/**
 * The address both halves read (src/shared/views.ts): the UI routes to it and the server answers every one of
 * them with the single page, so a parse that drifts means a bookmarked URL 404s or lands on the wrong view.
 */
import { describe, expect, it } from "vitest";
import { parsePath } from "../../src/shared/views.ts";

describe("parsePath", () => {
	it("reads the view, the session, both, and neither", () => {
		expect(parsePath("/")).toEqual({ view: "chat", session: null });
		expect(parsePath("/settings")).toEqual({ view: "settings", session: null });
		expect(parsePath("/secrets")).toEqual({ view: "secrets", session: null });
		expect(parsePath("/memory")).toEqual({ view: "memory", session: null });
		expect(parsePath("/sessions/2026-01-01T00-00-00-000Z_01a1.jsonl")).toEqual({
			view: "chat",
			session: "2026-01-01T00-00-00-000Z_01a1.jsonl",
		});
		// A view that also carries a session keeps both, so the server still answers it with the page.
		expect(parsePath("/settings/sessions/a.jsonl")).toEqual({ view: "settings", session: "a.jsonl" });
		// A page served under a subpath still names its view, and a name that is not a view is the chat.
		expect(parsePath("/flypi/settings")).toEqual({ view: "settings", session: null });
		expect(parsePath("/assets/app.js")).toEqual({ view: "chat", session: null });
		// `/sessions` with nothing after it names no session, so it is not an address.
		expect(parsePath("/sessions")).toEqual({ view: "chat", session: null });
	});
});
