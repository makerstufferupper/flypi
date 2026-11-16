import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

// Two projects from day one (docs/testing.md): node for src/**, happy-dom for ui/**.
// The Svelte plugin is at the root so both projects compile `.svelte` — the node project never
// imports one, so it costs nothing there.
export default defineConfig({
	plugins: [svelte()],
	test: {
		passWithNoTests: true,
		projects: [
			{ extends: true, test: { name: "node", environment: "node", include: ["tests/**/*.test.ts"] } },
			{
				extends: true,
				// The browser build of svelte, not the server build: `mount()` has to exist.
				resolve: { conditions: ["browser"] },
				test: { name: "dom", environment: "happy-dom", include: ["ui/**/*.test.ts"] },
			},
		],
		coverage: {
			provider: "v8",
			include: ["src/**", "ui/**"],
			// The page's entry point: it wires config → socket → mount, and the browser runs it once.
			// The html/css/shims are not code the coverage provider can parse, let alone run.
			exclude: ["ui/main.ts", "ui/index.html", "ui/app.css", "**/*.d.ts"],
			// `json-summary` belongs in this list rather than on the command line: the machine-readable
			// numbers a gate run quotes come out of coverage/coverage-summary.json, which `text`+`html`
			// never wrote, and --coverage.reporter=json-summary *replaces* this list instead of adding to
			// it — that run wrote the json and no index.html (measured at `a016cc2`).
			reporter: ["text", "html", "json-summary"],
			// A decision, not a default (vitest defaults it to false): this gates the reporters when a test
			// failed, while the thresholds are checked *inside* report generation, after them. So a
			// threshold-only failure — which #95's `src/**` branches floor makes every current run — wrote
			// a report, and a run that failed on a test wrote none at all: the run-start clean had already
			// wiped coverage/, so a flake left the next gate run nothing to read. On failure, report,
			// always. A red run's report carries no red/green marker of its own and vitest calls a CLI
			// run's map complete whatever failed, so check that run's exit status before quoting a number
			// out of it. (T43; measured at `a016cc2` both ways.)
			reportOnFailure: true,
			// Floors from docs/testing.md: 90% across src/**, 85% across ui/**, 100% on the choke
			// points named there — the mapper and the event log are where drift would hide.
			// Split per tree rather than one global number, which is what that doc prescribes when the
			// combined figure starts deciding server-code gates from UI coverage (it did, in Phase 4.5).
			thresholds: {
				"src/**": { lines: 90, branches: 90 },
				"src/server/protocol.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
			// Phase 5.5's choke points (docs/testing.md): a hole here costs a credential.
			"src/secrets/redact.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
			"src/secrets/crypto.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
				"src/server/event-log.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
				"src/shared/transcript.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
			"src/shared/metrics.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
				"ui/**": { lines: 85, branches: 85, functions: 85, statements: 85 },
			},
		},
	},
});
