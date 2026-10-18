/**
 * Auto-capture v1's rules (docs/memory.md Phase 4). These are cheap rules over what a turn just said and
 * ran, so what a test has to prove is the boundary: a stated fact is captured, a question is not, and two
 * commands that happen to be near each other are not a fix. A rule that over-captures costs a row and a
 * retrieval slot forever; one that misses is a fact the model can still be asked to store.
 */
import { describe, expect, it } from "vitest";
import { captureFromTurn, type ToolOutcome } from "../../src/memory/capture.ts";

const bodies = (prompt: string, tools: ToolOutcome[] = []) => captureFromTurn(prompt, tools).map((fact) => [fact.origin, fact.kind, fact.body]);

describe("auto-capture v1", () => {
	it("captures what the user wrote as a durable instruction, in their own words", () => {
		expect(bodies("Remember that we deploy to the small box.")).toEqual([["owner", "fact", "we deploy to the small box"]]);
		// The body stays the user's sentence: a paraphrase would be flypi guessing at what was said.
		expect(bodies("From now on we build with bun. Remember that the registry is private.")).toEqual([
			["owner", "fact", "we build with bun"],
			["owner", "fact", "the registry is private"],
		]);
	});

	it("captures a standing instruction or a correction, one sentence at a time", () => {
		expect(bodies("We never use npm in this repo. It breaks the CI pipeline.")).toEqual([
			["owner", "preference", "We never use npm in this repo"],
		]);
		expect(bodies("Please don't run the formatter over src/legacy any more.")).toEqual([
			["owner", "preference", "Please don't run the formatter over src/legacy any more"],
		]);
	});

	it("keeps a dotted path inside the fact, and still stops at the end of the sentence", () => {
		expect(bodies("Remember the release artifact lives in dist/flypi.tar.gz. Never the old one.")).toEqual([
			["owner", "fact", "the release artifact lives in dist/flypi.tar.gz"],
			// The second sentence is a standing instruction of its own, so it is captured on its own rules.
			["owner", "preference", "Never the old one"],
		]);
	});

	it("does not capture the same instruction twice", () => {
		// "remember …" is already a stated fact; the sentence also matches the standing-instruction rule.
		expect(captureFromTurn("Remember that we never use npm in this repo.").length).toBe(1);
	});

	it("leaves a question alone, because asking is not telling", () => {
		expect(captureFromTurn("Don't we use pnpm in this repo?")).toEqual([]);
		expect(captureFromTurn("What should we never use here?")).toEqual([]);
	});

	it("leaves a fragment, a bare acknowledgment and unrelated prose alone", () => {
		for (const prompt of ["Remember!", "ok noted", "the tests pass all green today"]) {
			expect(captureFromTurn(prompt), prompt).toEqual([]);
		}
	});

	// The accepted cost of a rule with no model: a sentence that merely contains one of these words reads
	// like a standing instruction. Over-capturing is the cheaper direction to be wrong in — the row is
	// visible, searchable and undoable — so this is stated rather than tuned away.
	it("over-captures a sentence that only happens to use a standing-instruction word", () => {
		expect(bodies("I never said anything about it.")).toEqual([["owner", "preference", "I never said anything about it"]]);
	});

	it("records a command that failed and the one that fixed it, as the agent's own finding", () => {
		const tools: ToolOutcome[] = [
			{ name: "bash", command: "npm run build", isError: true },
			{ name: "bash", command: "pnpm run build", isError: false },
		];
		expect(bodies("build it please", tools)).toEqual([["agent", "fact", "`npm run build` failed; `pnpm run build` worked"]]);
	});

	it("does not call an unrelated later command a fix", () => {
		const tools: ToolOutcome[] = [
			{ name: "bash", command: "ls -la", isError: true },
			{ name: "bash", command: "cat README.md", isError: false },
			{ name: "bash", command: "git commit -m wip", isError: true },
			{ name: "bash", command: "git push origin main", isError: false },
		];
		expect(captureFromTurn("", tools)).toEqual([]);
	});

	it("caps what one turn may write", () => {
		const prompt = "Remember the first thing here. Remember the second thing here. Remember the third thing here. Remember the fourth thing here.";
		expect(captureFromTurn(prompt).length).toBe(3);
	});

	it("takes facts written on separate lines", () => {
		const facts = captureFromTurn("Remember: migrations run before deploys.\nFrom now on, commit only after the tests pass.");
		expect(facts.map((fact) => fact.body)).toEqual([
			"migrations run before deploys",
			"commit only after the tests pass",
		]);
	});

	it("truncates a fact rather than storing a paragraph of it", () => {
		const facts = captureFromTurn(`remember that ${"the deploy target is the same host always ".repeat(40)}`);
		expect(facts).toHaveLength(1);
		expect(facts[0]!.body.length).toBeLessThanOrEqual(500);
	});

	// The sentence rule must not stop at a dot inside the fact itself — a version, a decimal, a file path.
	it("keeps dots that are part of the fact, and stops at the one that ends the sentence", () => {
		const facts = captureFromTurn("Remember that the minimum version is 2.7.1 and the gate lives in src/memory/capture.ts. Never trust a bare number.");
		expect(facts.map((fact) => fact.body)).toEqual([
			"the minimum version is 2.7.1 and the gate lives in src/memory/capture.ts",
			"Never trust a bare number",
		]);
	});

	it("ignores a tool result that ran no command", () => {
		// A file edit has no command line. Reading one as a command would make "failed" mean nothing.
		expect(captureFromTurn("Ship it.", [{ name: "edit", isError: true }, { name: "read", isError: false }])).toEqual([]);
	});
});
