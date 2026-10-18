/**
 * The `FLYPI_CACHE_PROBE=1` hash (docs/prompt-cache.md, the probe A3 deferred and C1 needs). Its whole job is
 * to be comparable: two runs of the same probe must produce identical lines for identical request bytes, and
 * differ on exactly the line where the bytes stopped being identical. Nothing else in this file matters, so
 * that is what is asserted — on the shape of an OpenAI-compatible request body, which is what the routes in
 * `.flypi/agent/models.json` send.
 */
import { describe, expect, it } from "vitest";
import { cacheProbeEnabled, cacheProbeLines, hashOf } from "../../src/shared/cache-probe.ts";

const system = { role: "system", content: "you are a helpful assistant" };
const user = (text: string) => ({ role: "user", content: text });

/** A request body of the kind a provider receives: prompt, then messages, then the tool declarations. */
const request = (messages: unknown[], tools = [{ name: "read", description: "read a file" }]) => ({
	model: "llama_a",
	messages,
	tools,
	max_tokens: 1024,
	stream: true,
});

const lineFor = (lines: string[], prefix: string) => lines.find((line) => line.startsWith(prefix));

describe("the cache probe (FLYPI_CACHE_PROBE)", () => {
	it("is on only for 1", () => {
		expect(cacheProbeEnabled({ FLYPI_CACHE_PROBE: "1" })).toBe(true);
		expect(cacheProbeEnabled({ FLYPI_CACHE_PROBE: "true" })).toBe(false);
		expect(cacheProbeEnabled({ FLYPI_CACHE_PROBE: "" })).toBe(false);
		expect(cacheProbeEnabled({})).toBe(false);
	});

	// The property the diff relies on: nothing in the output depends on when it was produced, and one changed
	// message moves exactly one message line plus the whole-request line. Read across two runs, the first
	// diverging `message N` is where the reusable prefix ended.
	it("hashes identical bytes identically, and moves only the line that changed", () => {
		const before = cacheProbeLines(request([system, user("list the files")]));
		expect(cacheProbeLines(request([system, user("list the files")]))).toEqual(before);

		const after = cacheProbeLines(request([system, user("how many are markdown?")]));
		const moved = after.filter((line, i) => line !== before[i]);
		expect(moved).toHaveLength(2);
		expect(moved[0]!).toMatch(/^payload sha=/);
		expect(moved[1]!).toMatch(/^message 1 role=user sha=/);
		expect(lineFor(after, "message 0 ")).toBe(lineFor(before, "message 0 "));
	});

	// Each line carries what C1 has to price and what a reader has to recognise: the role, the byte count,
	// and the request's total size. Tools are the other half of a prefix (docs/prompt-cache.md B: the 1462
	// that was reused at a boundary was tools plus the system message), so a change there is named too.
	it("prints the role, the size, and a hash for everything outside the messages", () => {
		const lines = cacheProbeLines(request([system, user("hi")], [{ name: "bash", description: "run a command" }]));
		expect(lines[0]!).toMatch(/^payload sha=[0-9a-f]{12} chars=\d+$/);
		expect(lineFor(lines, "message 0 ")).toBe(`message 0 role=system sha=${hashOf(system)} chars=${JSON.stringify(system).length}`);
		expect(lineFor(lines, "tools sha=")).toMatch(/^tools sha=[0-9a-f]{12}$/);
		expect(lineFor(lines, "model sha=")).toBeTruthy();
		expect(lines.join("\n")).not.toContain("messages sha=");

		// A different tool set is a different request even with the same messages, and it says so on its own line.
		const other = cacheProbeLines(request([system, user("hi")], [{ name: "edit", description: "edit a file" }]));
		expect(lineFor(other, "tools sha=")).not.toBe(lineFor(lines, "tools sha="));
		expect(lineFor(other, "message 0 ")).toBe(lineFor(lines, "message 0 "));
	});

	// A request shape this probe has never seen must still answer the one question it exists for, and never
	// take the probe run down with it.
	it("still hashes a payload with no messages array, and a payload that is not an object", () => {
		const body = { model: "x", prompt: "hello" };
		expect(cacheProbeLines(body)).toEqual([
			`payload sha=${hashOf(body)} chars=${JSON.stringify(body).length}`,
			`model sha=${hashOf("x")}`,
			`prompt sha=${hashOf("hello")}`,
		]);
		expect(cacheProbeLines(null)).toEqual([`payload sha=${hashOf(null)} chars=4`]);
		expect(cacheProbeLines(undefined)).toEqual([`payload sha=${hashOf(undefined)} chars=9`]);
		const bare = [{ role: "user" }];
		expect(cacheProbeLines(bare)).toEqual([`payload sha=${hashOf(bare)} chars=${JSON.stringify(bare).length}`]);
		// A field the adapter left undefined is not in the request bytes, so it gets no line — otherwise every
		// request would carry the same hash twice over and a reader would chase it.
		expect(cacheProbeLines({ model: "x", prompt_cache_key: undefined, stream: true })).toEqual([
			expect.stringMatching(/^payload sha=/),
			`model sha=${hashOf("x")}`,
			`stream sha=${hashOf(true)}`,
		]);
		// A malformed message still gets a line: dropping it would hide a real difference in the prefix.
		expect(cacheProbeLines({ messages: [{ content: "no role" }, undefined] })).toEqual([
			expect.stringMatching(/^payload sha=/),
			`message 0 role=? sha=${hashOf({ content: "no role" })} chars=${JSON.stringify({ content: "no role" }).length}`,
			`message 1 role=? sha=${hashOf(undefined)} chars=9`,
		]);
	});
});
