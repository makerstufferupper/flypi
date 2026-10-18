# transcript-log — a recorded multi-tool turn

`events.json` is the pi session event stream from one real turn: a scripted stub model
(tests/helpers/stub-model.ts) driving the real pi `read`, `edit` and `bash` tools against a
throwaway checkout whose failing test is a numeric sort. Regenerate with `npm run record`.
Timestamps, the stub nonce and temp-root paths are stripped; the bash card's test-runner
durations are the one thing that can differ between recordings.

Why it is committed: the same events drive the `renderMessage()` golden (`transcript.txt`),
the UI component tests and `scripts/smoke.mjs`. If those disagree, one of them is wrong.
Recorded against pi 1.0.4; session file `<root>/…jsonl`.
