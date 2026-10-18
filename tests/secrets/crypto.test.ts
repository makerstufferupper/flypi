/**
 * The vault's crypto and key seam (docs/secrets.md Phase 5.5) — a choke point under docs/testing.md, so
 * every branch here is asserted. The claim being tested is narrow and the only one that matters: a row that
 * was not sealed with this key fails loudly, and a row that did round-trip returns exactly the bytes that
 * went in. Anything weaker would put a wrong credential into an `apiKey` and nothing downstream would know.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	fingerprint,
	KEY_BYTES,
	keyfileProvider,
	mask,
	NONCE_BYTES,
	open,
	seal,
	SECRET_KINDS,
	validate,
} from "../../src/secrets/crypto.ts";

const KEY = new Uint8Array(KEY_BYTES).fill(7);
const OTHER = new Uint8Array(KEY_BYTES).fill(9);

/** A row, as the table would hold it, so a test can move one part of it. */
function rowOf(value: string, key = KEY) {
	const sealed = seal(value, key);
	return {
		valueCipher: new Uint8Array(sealed.valueCipher),
		valueNonce: new Uint8Array(sealed.valueNonce),
		valueTag: new Uint8Array(sealed.valueTag),
	};
}

describe("seal / open", () => {
	it("returns exactly what it was given", () => {
		for (const value of ["sk-test-1234567890", "", "ünïcode ✓ key", "a".repeat(100_000)]) {
			expect(open(rowOf(value), KEY)).toBe(value);
		}
	});

	it("uses a fresh nonce per call, so the same value never seals to the same bytes", () => {
		const a = rowOf("same value");
		const b = rowOf("same value");
		expect(Buffer.from(a.valueNonce).length).toBe(NONCE_BYTES);
		expect(Buffer.from(a.valueNonce).equals(Buffer.from(b.valueNonce))).toBe(false);
		expect(Buffer.from(a.valueCipher).equals(Buffer.from(b.valueCipher))).toBe(false);
	});

	it("fails on a different key rather than returning garbage", () => {
		expect(() => open(rowOf("sk-secret"), OTHER)).toThrow(/could not open this row/);
	});

	it("fails when any part of the row moved", () => {
		const row = rowOf("sk-secret");
		const tamperedCipher = new Uint8Array(row.valueCipher);
		tamperedCipher[0] = (tamperedCipher[0] ?? 0) ^ 1;
		expect(() => open({ ...row, valueCipher: tamperedCipher }, KEY)).toThrow(/could not open this row/);

		const tamperedTag = new Uint8Array(row.valueTag);
		tamperedTag[0] = (tamperedTag[0] ?? 0) ^ 1;
		expect(() => open({ ...row, valueTag: tamperedTag }, KEY)).toThrow(/could not open this row/);

		const swappedNonce = new Uint8Array(rowOf("other").valueNonce);
		expect(() => open({ ...row, valueNonce: swappedNonce }, KEY)).toThrow(/could not open this row/);
	});
});

describe("fingerprint and mask", () => {
	it("fingerprints a value stably, so a repeat write can be spotted without decrypting", () => {
		expect(fingerprint("sk-abc")).toBe(fingerprint("sk-abc"));
		expect(fingerprint("sk-abc")).not.toBe(fingerprint("sk-abd"));
		expect(fingerprint("sk-abc")).toMatch(/^[0-9a-f]{64}$/);
	});

	it("shows the head and tail of a key, which is how a user tells two of them apart", () => {
		expect(mask("sk-proj-aBcD1234567890", "password")).toBe("sk-…7890");
	});

	it("shows no characters at all of a short value", () => {
		expect(mask("hunter2", "password")).toBe("•••••");
		expect(mask("12345678", "password")).toBe("•••••");
	});

	it("masks an SSH key as a fingerprint, the way `ssh-keygen -lf` reads", () => {
		const pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPublicKeyMaterial user@host";
		for (const kind of ["ssh_public_key", "ssh_private_key"] as const) {
			const shown = mask(pub, kind);
			expect(shown).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
			expect(shown).not.toContain("AAAAC3");
			// The point of a fingerprint: two keys differ, the same key does not.
			expect(shown).toBe(mask(pub, kind));
			expect(shown).not.toBe(mask(`${pub}x`, kind));
		}
	});

	it("every kind has a mask that contains no middle of the value", () => {
		const value = "abcdefghijklmnopqrstuvwxyz0123456789";
		for (const kind of SECRET_KINDS) {
			const shown = mask(value, kind);
			expect(shown).not.toContain("ghijkl");
		}
	});

	it("keeps the mask of a multi-line yaml blob on one line", () => {
		const kubeconfig = "apiVersion: v1\nkind: Config\nclusters:\n  - name: home\n    server: https://192.168.1.10:6443\n";
		const shown = mask(kubeconfig, "yaml");
		expect(shown).not.toContain("\n");
		// The first line of a document is its type, which is worth showing; the value itself is not there.
		expect(shown).toBe("api…6443");
		expect(shown).not.toContain("apiVersion");
	});
});

describe("validate", () => {
	const document = "apiVersion: v1\nkind: Config\nclusters:\n  - name: home\n    server: https://192.168.1.10:6443\n";

	it("accepts every kind that is only ever a string", () => {
		for (const kind of SECRET_KINDS.filter((kind) => kind !== "yaml")) {
			expect(validate("hunter2", kind)).toBeNull();
			expect(validate("not: even: close to yaml", kind)).toBeNull();
		}
	});

	it("accepts a yaml document, whatever it describes", () => {
		expect(validate(document, "yaml")).toBeNull();
		// Syntax is the claim; the shape of the document is nobody else's business.
		expect(validate("just a string\n", "yaml")).toBeNull();
	});

	it("refuses yaml that does not parse, and names where it broke", () => {
		const problem = validate("clusters:\n  - name: home\n   server: oops\n", "yaml");
		expect(problem).toMatch(/^is not valid YAML:/);
		expect(problem).toMatch(/line \d+, column \d+/);
		// The panel shows this in one line; a code frame would not fit.
		expect(problem).not.toContain("\n");
	});
});

describe("keyfileProvider", () => {
	const tempKey = () => {
		const dir = mkdtempSync(join(tmpdir(), "flypi-key-"));
		return { file: join(dir, "secret.key"), dispose: () => rmSync(dir, { recursive: true, force: true }) };
	};

	it("creates the key file on first use, readable only by the owner", () => {
		const { file, dispose } = tempKey();
		try {
			const keys = keyfileProvider(file);
			expect(keys.currentVersion()).toBe(1);
			expect(keys.key(1)).toHaveLength(KEY_BYTES);
			// The mode is the whole point of a key file: `ls -l` is a backup that should not leak it.
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(readFileSync(file, "utf8")).not.toContain("key material in the clear that a user typed");
		} finally {
			dispose();
		}
	});

	it("keeps the same key across a reopen — the vault must not be stranded by a new process", () => {
		const { file, dispose } = tempKey();
		try {
			const first = keyfileProvider(file).key(1);
			const again = keyfileProvider(file).key(1);
			expect(Buffer.from(again!)).toEqual(Buffer.from(first!));
		} finally {
			dispose();
		}
	});

	it("rotates without forgetting the old key, and forgets only when told to", () => {
		const { file, dispose } = tempKey();
		try {
			const keys = keyfileProvider(file);
			const old = keys.key(1)!;
			expect(keys.rotate()).toBe(2);
			expect(keys.currentVersion()).toBe(2);
			// A row sealed under v1 is still readable until `reencrypt` has moved it — that is the ordering
			// the migration comment in src/memory/db.ts insists on.
			expect(Buffer.from(keys.key(1)!)).toEqual(Buffer.from(old));
			expect(keys.key(2)).toHaveLength(KEY_BYTES);

			keys.retain([2]);
			expect(keys.key(1)).toBeUndefined();
			expect(keys.key(2)).toHaveLength(KEY_BYTES);
			// The current key is never droppable: without it every new write fails.
			keys.retain([]);
			expect(keys.key(2)).toHaveLength(KEY_BYTES);
		} finally {
			dispose();
		}
	});

	it("refuses a file it cannot read instead of replacing it with a fresh key", () => {
		const { file, dispose } = tempKey();
		try {
			writeFileSync(file, "not json");
			expect(() => keyfileProvider(file).currentVersion()).toThrow(/not a key file flypi can read/);
		} finally {
			dispose();
		}
	});

	it("refuses a file that parses but is not a key ring", () => {
		const { file, dispose } = tempKey();
		try {
			writeFileSync(file, JSON.stringify({ keys: {} }));
			expect(() => keyfileProvider(file).currentVersion()).toThrow(/not a key file flypi can read/);
		} finally {
			dispose();
		}
	});
});
