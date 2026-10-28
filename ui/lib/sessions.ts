/**
 * How a session is named, in one place. The sidebar's rows and the phone's top bar name the same session,
 * and a header that disagrees with the row it names is the kind of drift this codebase refuses: the name
 * the user gave it, then its first message, then its path as the last resort. Both callers take these two
 * strings and render them differently — the row is the editing surface, the bar is text — but the choice
 * of string is one function.
 */
import type { SessionSummary } from "../../src/server/protocol.ts";

/** The editable label: the name, or the first message as the hint for a session that has none yet. */
export function sessionHint(session: SessionSummary): string {
	return session.name || session.firstMessage;
}

/** The label with the path as the last resort: a new session has neither a name nor a first message. */
export function sessionTitle(session: SessionSummary): string {
	return sessionHint(session) || session.path;
}
