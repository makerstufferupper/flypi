#!/usr/bin/env node
/**
 * Record `tests/fixtures/transcript-log` — the event sequence one real multi-tool turn produces
 * (read → edit → read → bash → answer, with the real pi tools running against a throwaway
 * checkout), plus the text render of it. The same fixture drives the `renderMessage()` golden,
 * the UI component tests and `scripts/smoke.mjs`, which is why it is recorded once and committed.
 *
 *   npm run record
 *
 * Determinism: timestamps, the stub model's per-call nonce, and absolute paths under the temp
 * root are stripped (tests/helpers/flypi-harness.ts `normalize`). What is left is what a client
 * would actually render. The `node --test` output in the bash card carries durations, so
 * re-recording can shift those numbers — that is the one thing that legitimately changes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness, normalize } from "../tests/helpers/flypi-harness.ts";
import { reduceEvents, renderTranscriptText } from "../src/shared/transcript.ts";
import { FIX_THE_FAILING_TEST, fixTheFailingTest, writeFailingTestRepo } from "../tests/helpers/recorded-turn.ts";

const FIXTURE_DIR = join(import.meta.dirname, "..", "tests", "fixtures", "transcript-log");

const h = await harness(() => fixTheFailingTest(), { tools: ["read", "edit", "bash"] });
const root = h.root;
writeFailingTestRepo(root);
try {
	const conversation = await h.registry.create();
	const events: unknown[] = [];
	h.registry.attach(conversation.id, (_seq, event) => events.push(event));
	await h.registry.prompt(conversation.id, FIX_THE_FAILING_TEST);
	for (let attempt = 0; attempt < 500 && h.registry.get(conversation.id).session.isStreaming; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	// The session file must exist on disk before it is reported; a turn flushes it.
	const sessionPath = h.registry.get(conversation.id).session.sessionFile;

	const normalized = normalize(events, root) as Record<string, unknown>[];
	mkdirSync(FIXTURE_DIR, { recursive: true });
	writeFileSync(join(FIXTURE_DIR, "events.json"), `${JSON.stringify(normalized, null, 1)}\n`);
	writeFileSync(
		join(FIXTURE_DIR, "transcript.txt"),
		renderTranscriptText(reduceEvents(normalized as never)),
	);
	writeFileSync(
		join(FIXTURE_DIR, "README.md"),
		`# transcript-log — a recorded multi-tool turn

\`events.json\` is the pi session event stream from one real turn: a scripted stub model
(tests/helpers/stub-model.ts) driving the real pi \`read\`, \`edit\` and \`bash\` tools against a
throwaway checkout whose failing test is a numeric sort. Regenerate with \`npm run record\`.
Timestamps, the stub nonce and temp-root paths are stripped; the bash card's test-runner
durations are the one thing that can differ between recordings.

Why it is committed: the same events drive the \`renderMessage()\` golden (\`transcript.txt\`),
the UI component tests and \`scripts/smoke.mjs\`. If those disagree, one of them is wrong.
Recorded against pi ${process.env.FLYPI_PI_VERSION ?? "1.0.4"}; session file \`${sessionPath ? "<root>/…jsonl" : "(none)"}\`.
`,
	);
	console.log(`recorded ${normalized.length} events → tests/fixtures/transcript-log`);
	console.log(readFileSync(join(FIXTURE_DIR, "transcript.txt"), "utf8"));
} finally {
	h.cleanup();
}
