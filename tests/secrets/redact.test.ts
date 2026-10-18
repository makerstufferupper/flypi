/**
 * The redaction boundary (docs/secrets.md Phase 5.5) — the second choke point. Everything that keeps a
 * secret out of a memory row, a session file or an HTML export goes through these four functions, so the
 * assertions here are about what text comes out, not about what was configured on the way in.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	containsSecret,
	invalidateSecrets,
	MIN_SECRET_CHARS,
	redactSecrets,
	setSecretSource,
	shortSecrets,
	type ActiveSecret,
} from "../../src/secrets/redact.ts";

/** A source a test can count: the boundary is a pull, so how often it asks is part of the contract. */
function sourceOf(secrets: ActiveSecret[], count: { reads: number } = { reads: 0 }) {
	return () => {
		count.reads += 1;
		return secrets;
	};
}

beforeEach(() => {
	// No global carries over between these: an unset source means nothing is redacted, and a test that
	// forgot to set one would otherwise pass on the previous test's secrets.
	invalidateSecrets();
	setSecretSource(() => []);
});

describe("redactSecrets", () => {
	it("leaves text alone when the process has no vault", () => {
		expect(redactSecrets("my key is sk-abcdef12345")).toBe("my key is sk-abcdef12345");
	});

	it("replaces a known value with a named placeholder", () => {
		setSecretSource(sourceOf([{ name: "openai_key", value: "sk-abcdef12345" }]));
		expect(redactSecrets("use sk-abcdef12345 for the import")).toBe("use [secret:openai_key] for the import");
	});

	it("is idempotent: the placeholder is not itself a secret", () => {
		setSecretSource(sourceOf([{ name: "openai_key", value: "sk-abcdef12345" }]));
		const once = redactSecrets("sk-abcdef12345");
		expect(redactSecrets(once)).toBe(once);
	});

	it("matches the longest value first, so a short one cannot eat part of a long one", () => {
		setSecretSource(sourceOf([
			{ name: "short", value: "sk-1234" },
			{ name: "long", value: "sk-1234567890" },
		]));
		expect(redactSecrets("sk-1234567890 and sk-1234")).toBe("[secret:long] and [secret:short]");
	});

	it("escapes a value that is full of regex characters", () => {
		setSecretSource(sourceOf([{ name: "regex", value: "a.*b(c+)d$e^f|g[h]i{j}k\\l" }]));
		expect(redactSecrets("the value a.*b(c+)d$e^f|g[h]i{j}k\\l ends here")).toBe("the value [secret:regex] ends here");
	});

	it("names every secret a value is stored under, rather than picking one", () => {
		setSecretSource(sourceOf([
			{ name: "shared_a", value: "same-token-value" },
			{ name: "shared_b", value: "same-token-value" },
		]));
		expect(redactSecrets("same-token-value")).toBe("[secret:shared_a][secret:shared_b]");
	});

	it("redacts every occurrence, not just the first", () => {
		setSecretSource(sourceOf([{ name: "tok", value: "tok-1234567" }]));
		expect(redactSecrets("tok-1234567 … tok-1234567")).toBe("[secret:tok] … [secret:tok]");
	});
});

describe("the short-value rule", () => {
	it("does not redact a value too short to be safe to match", () => {
		setSecretSource(sourceOf([{ name: "pin", value: "1234" }]));
		expect(redactSecrets("the pin is 1234 and 123456789 is a number")).toBe("the pin is 1234 and 123456789 is a number");
	});

	it("reports the values it will not catch, so the gap is visible somewhere", () => {
		setSecretSource(sourceOf([
			{ name: "pin", value: "1234" },
			{ name: "long_enough", value: "x".repeat(MIN_SECRET_CHARS) },
		]));
		expect(shortSecrets()).toEqual(["pin"]);
	});

	it("a value split across two chunks matches neither half — the gap in the live stream", () => {
		// This is the limitation the Secrets view states out loud (docs/secrets.md): nothing that works on a
		// chunk of text can see a value that has not finished arriving. The stream filter catches it as soon as
		// the last piece lands, which is why it reads the accumulated partial rather than the deltas.
		setSecretSource(sourceOf([{ name: "api", value: "api-9876543210" }]));
		expect(redactSecrets("the key starts api-987")).toBe("the key starts api-987");
		expect(redactSecrets("api-9876543210")).toBe("[secret:api]");
	});
});

describe("containsSecret", () => {
	it("says whether a body would lose a secret on the way in", () => {
		setSecretSource(sourceOf([{ name: "api", value: "api-9876543210" }]));
		expect(containsSecret("the api-9876543210 is rotated monthly")).toBe(true);
		expect(containsSecret("nothing sensitive here")).toBe(false);
	});

	it("asks the same question twice with the same answer (no regex state carried over)", () => {
		setSecretSource(sourceOf([{ name: "api", value: "api-9876543210" }]));
		expect(containsSecret("api-9876543210")).toBe(true);
		expect(containsSecret("api-9876543210")).toBe(true);
	});
});

describe("where the values come from", () => {
	it("reads the source once and reuses it, so storing one does not mean decrypting the vault per memory", () => {
		const count = { reads: 0 };
		setSecretSource(sourceOf([{ name: "a", value: "aaaaaa" }], count));
		redactSecrets("aaaaaa");
		redactSecrets("aaaaaa");
		expect(count.reads).toBe(1);
	});

	it("asks again the moment this process changes the vault", () => {
		const first = sourceOf([{ name: "a", value: "aaaaaa" }]);
		const second = sourceOf([{ name: "b", value: "bbbbbb" }]);
		setSecretSource(first);
		expect(redactSecrets("aaaaaa bbbbbb")).toBe("[secret:a] bbbbbb");
		setSecretSource(second);
		expect(redactSecrets("aaaaaa bbbbbb")).toBe("aaaaaa [secret:b]");
	});

	it("expires the list it read, which is how a secret stored by another process gets protected", () => {
		const count = { reads: 0 };
		setSecretSource(sourceOf([{ name: "a", value: "aaaaaa" }], count), { maxAgeMs: 1 });
		redactSecrets("aaaaaa");
		// Not a sleep on a timer: 1 ms and a synchronous turn of the event loop is enough, and a test that
		// waited on a long timeout would be testing patience instead of the rule.
		const started = Date.now();
		while (Date.now() - started < 5) {
			/* turn */
		}
		redactSecrets("aaaaaa");
		expect(count.reads).toBeGreaterThan(1);
	});
});
