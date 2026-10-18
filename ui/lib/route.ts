/**
 * The address bar says what this page is showing. `/sessions/<session file name>` names the conversation on
 * screen and `/` is a chat with none; `/settings`, `/secrets` and `/memory` name a view, which owns the whole
 * address — those views are about the agent, not this conversation, so a session is not recorded alongside
 * them, and going back to the chat writes it again. Either way, reloading, bookmarking or sharing a URL lands
 * where the page was. Like the theme (theme.ts) and the column widths (panels.ts) this is the page's own
 * state: read and written here, never sent over the socket, and `FlypiAppState` stays DOM-free.
 *
 * The address is a path because that is what a person would write. The server answers those paths with the
 * one page it already serves (`parsePath`, src/shared/views.ts and src/server/index.ts), and the built UI's
 * assets are root-absolute, so the page loads the same way from any of them.
 */
import { parsePath, SESSIONS_SEGMENT, type View } from "../../src/shared/views.ts";

export type { View };

/**
 * The session's own name: the file name `listSessions` and `switchSession` already speak, without the
 * directory in front of it. The address bar holds that, not the whole path — the server knows where its own
 * sessions live and resolves the name there (`sessionFileIn`, src/server/session-registry.ts) — so the URL
 * is `base_url/sessions/session_id` and carries nothing about where this checkout sits on disk.
 */
export function sessionId(path: string): string {
	return path.split("/").pop() ?? path;
}

/** The view and the session the address bar asks for; the chat and no session are what anything else means. */
export function readRoute(): { view: View; session: string | null } {
	return parsePath(location.pathname);
}

/**
 * Rewrite the current address bar entry in place: what is on screen follows the socket and the buttons, so
 * the URL stays an honest record of this moment rather than a history the sidebar already is. Leaving the
 * settings view is the button on it, not the back button.
 */
export function writeRoute(view: View, session: string | null): void {
	const path = view === "chat" ? (session ? `/${SESSIONS_SEGMENT}/${sessionId(session)}` : "/") : `/${view}`;
	if (path === location.pathname) return;
	history.replaceState(null, "", `${path}${location.hash}`);
}
