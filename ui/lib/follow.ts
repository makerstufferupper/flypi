/**
 * Where one scrolling list was for each session, and whether it was following the newest entry.
 *
 * A list is a single DOM node that is reused as the chat — or the activity entries — change underneath
 * it. Without this, a switch inherits the previous session's `scrollTop` **and** its "follow" flag: the
 * new chat opens at an old place, and then the follow effect drags it to the end. The list belongs to the
 * page; the place in it belongs to the session.
 *
 * `following` is deliberately a plain field rather than reactive state: it is read when a render or a
 * scroll happens, and making it reactive would re-run the follow effect every time the reader moves the
 * list — the opposite of what it is for.
 */
export class FollowNewest {
	private readonly places = new Map<string, { top: number; following: boolean }>();
	private shown: string | undefined;
	/** True while the newest entry should stay in view. */
	following = true;

	/** From the list's scroll handler: the reader's place becomes this session's place. */
	remember(key: string | undefined, node: HTMLElement | undefined): void {
		if (!key || !node) return;
		this.following = atBottom(node);
		this.places.set(key, { top: node.scrollTop, following: this.following });
	}

	/** True the first time this list shows `key` — a switch, or the first session to be shown. */
	switched(key: string | undefined): boolean {
		if (key === this.shown) return false;
		this.shown = key;
		this.following = (key ? this.places.get(key)?.following : undefined) ?? true;
		return true;
	}

	/** Put the list where that session left it — or at its newest entry if it was following. */
	land(key: string | undefined, node: HTMLElement): void {
		const saved = key ? this.places.get(key) : undefined;
		node.scrollTop = saved && !saved.following ? saved.top : node.scrollHeight;
		// Landing somewhere is not the reader scrolling away from the newest entry.
		this.following = atBottom(node);
	}

	/** Keep the newest entry in view, unless the reader scrolled up to read something older. */
	keep(node: HTMLElement | undefined): void {
		if (node && this.following) node.scrollTop = node.scrollHeight;
	}
}

/** "Near enough to the bottom" — the same slack the lists used before they were per-session. */
function atBottom(node: HTMLElement): boolean {
	return node.scrollHeight - node.scrollTop - node.clientHeight < 40;
}
