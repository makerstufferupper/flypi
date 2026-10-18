/**
 * The review fork (docs/memory.md Phase 4.8): learning that does not wait for a sweep.
 *
 * Every `memory.reviewInterval` delivered answers, flypi forks a detached agent over a *snapshot* of the
 * conversation and asks it one question — save what is worth saving, or say so. It has to exist because
 * capture is otherwise a word list (src/memory/capture.ts), and a correction phrased unusually, a convention
 * earned over a long tool run, or a preference never typed as a sentence are invisible to it.
 *
 * The rule everything else follows from: **nothing a fork says reaches a conversation a human reads.** The
 * fork runs on pi's own non-persisting session (`SessionManager.inMemory`, seeded with the parent's entries),
 * so it can write memories and cannot write the session file. hermes hand-built that isolation and its comment
 * names the bug it prevents: a fork that writes its harness turn into the real session has it re-read by the
 * next live turn as a standing instruction — risk 4 in a new costume.
 *
 * Why it is cheap: same provider and model, the same system-prompt bytes (byte-stable since Phase 4.6 B), the
 * same advertised `tools[]`, and the memory block already in the seeded history (Phase 4.7 C2) — so the fork's
 * request *extends a prefix the route has already read* instead of paying cold. That is why the write gate
 * lives at the store (src/memory/mcp.ts) rather than in a smaller tool list: shrinking `tools[]` is a
 * different request, and the cache is gone.
 *
 * This file holds the parts that need no session: what the fork is asked, and how its session is configured.
 * The fork itself is created by `createFlypiSession` — the one place flypi creates an `AgentSession`, so the
 * config-isolation invariant (risk 1) is enforced once (src/agent/runtime.ts).
 */
import type { LoadedMcpConfig, SessionEntry } from "@earendil-works/pi-coding-agent";
import { memoryTool } from "./recall.ts";

/**
 * What the recall extension hands the fork runner when it fires: the conversation exactly as the parent holds
 * it, entries and all. The runner seeds a non-persisting session with them, so the fork sees the same
 * transcript — including the memory block — and writes to none of it.
 */
export type ReviewParent = { entries: SessionEntry[] };

/** The fork, as the recall extension calls it: fire and forget, the answer was already delivered. */
export type ReviewFork = (parent: ReviewParent) => Promise<void>;

/**
 * The fork's prompt. Three things hermes learned the hard way (`agent/background_review.py`), each of which
 * fails open if left out:
 *
 * - **one fact per row, filed by what it is about** — hermes has two stores and a routing rule; flypi has one
 *   store and a free-form `kind`, so the rule becomes "never put a fact about the user in the same row as a
 *   fact about this machine", because a mixed row is filed wrong for half of itself.
 * - **the do-not-capture list** — environment-dependent failures, negative claims about tools, errors that
 *   already resolved, attempts that never worked. These harden into constraints the agent cites against
 *   itself long after the problem was fixed.
 * - **an explicit "say so and stop"** — a review that finds nothing must write nothing, or the store fills
 *   with summaries of small talk.
 */
export function reviewPrompt(serverName: string): string {
	const write = memoryTool(serverName, "memory_write");
	return [
		"Review the conversation above. It has already been answered — you are not replying to it.",
		"",
		`Save what is worth keeping and nothing else: one call to ${write} per durable fact, with a kind that names what the fact is about.`,
		"One fact per call. Never put a fact about the user in the same row as a fact about this machine or repository: a mixed row is filed wrong for half of itself.",
		"Do not save a failure that only happens in this environment, a claim that some tool does not work, an error that already resolved inside this conversation, or an attempt that never worked. Those turn into rules you will cite against yourself long after the problem was fixed.",
		"Do not save what the memories above already say, and do not restate one in different words.",
		"You may add memories. You may not replace, delete, or claim the user's own words for one — if an existing memory is now wrong, say so in your reply instead.",
		'If nothing stands out, reply exactly "Nothing to save" and stop.',
	].join("\n");
}

/**
 * The same MCP config with the memory server on the background mount (src/memory/mcp.ts `MOUNTS`), which is
 * what makes its writes land `session_kind='background'`. The entry keeps its name, exposure and
 * `toolExposure`, so the tools the fork is offered are the tools the parent was offered — byte-identical,
 * which is the cache-parity claim.
 *
 * shortcut: only the HTTP memory server gets rewritten, because that is the only mount flypi's own template
 * configures; a memory server on a stdio entry or a path that is not `/mcp` keeps its URL and its writes land
 * `interactive`. Move the mount onto the entry itself if a non-standard one ever ships.
 */
export function backgroundMount(config: LoadedMcpConfig, serverName: string): LoadedMcpConfig {
	return {
		...config,
		servers: config.servers.map((entry) => {
			if (entry.name !== serverName || !("url" in entry.config)) return entry;
			const url = new URL(entry.config.url);
			if (!url.pathname.endsWith("/mcp")) return entry;
			url.pathname = `${url.pathname}/background`;
			return { ...entry, config: { ...entry.config, url: url.href } };
		}),
	};
}
