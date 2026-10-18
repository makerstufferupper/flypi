/**
 * The app's addresses that are not files: the views `/settings`, `/secrets`, `/memory`, and the conversation
 * `/sessions/<session file name>`. The chat with no session named is the one at `/`. Both halves need the
 * same names — the UI routes to them (`ui/lib/route.ts`) and the server answers them with the one page it
 * already serves (`src/server/index.ts`) — so a link that works in one cannot drift away from the other.
 */
export const VIEW_PATHS = ["settings", "secrets", "memory"] as const;

/** Which of the page's views is on screen. `chat` is the one that names nothing. */
export type View = "chat" | (typeof VIEW_PATHS)[number];

/** The address that names a conversation: `/sessions/<session file name>`. */
export const SESSIONS_SEGMENT = "sessions";

/**
 * Reads an address the way both halves need it — the view it names, and the session it names. A view owns
 * the whole address (`/settings`) and a session owns it too (`/sessions/<id>`); the view is the segment the
 * address ends with, or the one before `/sessions` if a session follows, so a page served under a subpath
 * still names its view and an address that carries both is read without losing either. The session is the
 * file name alone: the server knows where its sessions live (`sessionFileIn`, src/server/session-registry.ts),
 * so no path from this checkout is ever put in a URL.
 */
export function parsePath(path: string): { view: View; session: string | null } {
	const segments = path.split("/").filter(Boolean);
	const at = segments.lastIndexOf(SESSIONS_SEGMENT);
	const named = at >= 0 ? (segments[at - 1] ?? "") : (segments.at(-1) ?? "");
	return {
		view: (VIEW_PATHS as readonly string[]).includes(named) ? (named as View) : "chat",
		session: at >= 0 ? (segments[at + 1] ?? null) : null,
	};
}
