/**
 * The vault store (docs/secrets.md Phase 5.5). What is asserted here is the set of promises the table makes:
 * a read path never yields a plaintext, a value stored twice is not stored twice, deleting is reversible,
 * every change keeps an audit row with its pre-image, and a key rotation leaves a row that cannot be opened
 * until the key is restored — never a wrong plaintext.
 */
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KEY_BYTES, keyfileProvider } from "../../src/secrets/crypto.ts";
import { REENCRYPT_JOB, type SecretStore } from "../../src/secrets/vault.ts";
import { auditOf, tempVault } from "../helpers/secret-vault.ts";

const KEY_VALUE = "sk-proj-abcdefghijklmnopqrstuvwxyz01";

describe("storing", () => {
	it("stores a value and lists only a mask back", () => {
		const { vault, dispose } = tempVault();
		try {
			const stored = vault.put({ name: "openai_key", value: KEY_VALUE, kind: "password", actor: "test" });
			expect(stored.status).toBe("stored");
			const row = vault.row("openai_key")!;
			expect(row.mask).toBe("sk-…yz01");
			expect(JSON.stringify(vault.list())).not.toContain(KEY_VALUE);
			expect(vault.activeValues()).toEqual([{ name: "openai_key", value: KEY_VALUE }]);
		} finally {
			dispose();
		}
	});

	it("keeps the ciphertext, nonce and tag in separate columns, and no plaintext anywhere in the file", () => {
		const { vault, db, paths, dispose } = tempVault();
		try {
			vault.put({ name: "openai_key", value: KEY_VALUE, kind: "password", actor: "test" });
			const raw = db.prepare("SELECT value_cipher, value_nonce, value_tag, fingerprint, mask, key_version FROM secrets").get() as Record<string, unknown>;
			expect(Buffer.from(raw.value_cipher as Uint8Array).toString("utf8")).not.toContain(KEY_VALUE);
			expect(Buffer.from(raw.value_nonce as Uint8Array)).toHaveLength(12);
			expect(Buffer.from(raw.value_tag as Uint8Array)).toHaveLength(16);
			expect(raw.key_version).toBe(1);
			// The files themselves — a backup, a `strings` run and a crash dump must not carry the credential.
			// WAL means the newest bytes may be in the -wal file, so both are read.
			const onDisk = [paths.memoryDbPath, `${paths.memoryDbPath}-wal`]
				.map((file) => {
					try {
						return readFileSync(file).toString("latin1");
					} catch {
						return "";
					}
				})
				.join("");
			expect(onDisk).not.toContain(KEY_VALUE);
		} finally {
			dispose();
		}
	});

	it("refuses a name that would not survive being a file name", () => {
		const { vault, dispose } = tempVault();
		try {
			expect(() => vault.put({ name: "../escape", value: KEY_VALUE, actor: "test" })).toThrow(/not a usable secret name/);
			expect(() => vault.put({ name: "", value: KEY_VALUE, actor: "test" })).toThrow(/not a usable secret name/);
		} finally {
			dispose();
		}
	});

	it("refuses a yaml value that does not parse, and stores one that does", () => {
		const { vault, dispose } = tempVault();
		const kubeconfig = "apiVersion: v1\nkind: Config\nclusters:\n  - name: home\n    server: https://192.168.1.10:6443\n";
		try {
			expect(() => vault.put({ name: "kube_config", value: "clusters:\n  - name: home\n   server: oops\n", kind: "yaml", actor: "test" })).toThrow(/"kube_config" is not valid YAML/);
			expect(vault.row("kube_config")).toBeUndefined();

			expect(vault.put({ name: "kube_config", value: kubeconfig, kind: "yaml", actor: "test" }).status).toBe("stored");
			// The blob is what `secret_file` will hand to a command, so it comes back byte for byte — and the
			// mask that the list shows is still one line.
			expect(vault.value("kube_config", { actor: "test", action: "revealed" })).toBe(kubeconfig);
			expect(vault.row("kube_config")!.mask).not.toContain("\n");

			// Rotating is checked the same way, and a refusal leaves the stored value where it was.
			expect(() => vault.rotate({ name: "kube_config", value: "a: [1, 2", kind: "yaml", actor: "test" })).toThrow(/is not valid YAML/);
			expect(vault.value("kube_config", { actor: "test", action: "revealed" })).toBe(kubeconfig);
		} finally {
			dispose();
		}
	});

	it("does not store the same value twice under a second name", () => {
		const { vault, dispose } = tempVault();
		try {
			vault.put({ name: "openai_key", value: KEY_VALUE, kind: "password", actor: "test" });
			expect(vault.put({ name: "backup_key", value: KEY_VALUE, actor: "test" })).toEqual({ status: "exists", name: "openai_key", id: expect.any(Number) });
			expect(vault.list().map((row) => row.name)).toEqual(["openai_key"]);
		} finally {
			dispose();
		}
	});

	it("says when a name is taken by a different value instead of overwriting it", () => {
		const { vault, dispose } = tempVault();
		try {
			vault.put({ name: "token", value: "aaaaaa-1111", actor: "test" });
			const second = vault.put({ name: "token", value: "bbbbbb-2222", actor: "test" });
			expect(second.status).toBe("name taken");
			expect(vault.value("token", { actor: "test", action: "used" })).toBe("aaaaaa-1111");
		} finally {
			dispose();
		}
	});

	it("records metadata as text, which is where the scope and the expiry belong", () => {
		const { vault, dispose } = tempVault();
		try {
			vault.put({ name: "gh", value: KEY_VALUE, kind: "password", meta: { scope: "repo", expires: "2027-01-01" }, actor: "test" });
			expect(vault.row("gh")!.meta).toEqual({ scope: "repo", expires: "2027-01-01" });
		} finally {
			dispose();
		}
	});
});

describe("using", () => {
	const withSecret = (): { vault: SecretStore; dispose: () => void } => {
		const held = tempVault();
		held.vault.put({ name: "openai_key", value: KEY_VALUE, kind: "password", meta: { scope: "read" }, actor: "test" });
		return { vault: held.vault, dispose: held.dispose };
	};

	it("counts uses and records each one with who asked", () => {
		const { vault, dispose } = withSecret();
		try {
			expect(vault.value("openai_key", { actor: "agent", action: "used" })).toBe(KEY_VALUE);
			expect(vault.value("openai_key", { actor: "cli", action: "revealed" })).toBe(KEY_VALUE);
			const row = vault.row("openai_key")!;
			expect(row.use_count).toBe(2);
			expect(row.last_used_at).toBeTruthy();
			expect(vault.uses("openai_key").map((use) => [use.actor, use.action])).toEqual([
				["cli", "revealed"],
				["agent", "used"],
				["test", "put"],
			]);
		} finally {
			dispose();
		}
	});

	it("records each change and each use, and what a use does not keep", () => {
		const { vault, dispose } = withSecret();
		try {
			vault.value("openai_key", { actor: "agent", action: "used" });
			expect(auditOf(vault.db, "openai_key")).toEqual([
				{ action: "put", preImage: { name: "openai_key", key_version: 1 } },
				{ action: "used", preImage: { name: "openai_key", key_version: null } },
			]);
		} finally {
			dispose();
		}
	});

	it("says nothing for a name that is not there, rather than throwing at a model", () => {
		const { vault, dispose } = withSecret();
		try {
			expect(vault.value("nope", { actor: "agent", action: "used" })).toBeUndefined();
			expect(vault.row("nope")).toBeUndefined();
			expect(vault.uses("nope")).toEqual([]);
		} finally {
			dispose();
		}
	});
});

describe("rotating a value", () => {
	it("replaces the value and keeps the pre-image of the one it replaced", () => {
		const { vault, db, dispose } = tempVault();
		try {
			vault.put({ name: "token", value: "aaaaaa-1111", kind: "password", actor: "test" });
			const rotated = vault.rotate({ name: "token", value: "bbbbbb-2222", actor: "test" });
			expect(rotated.status).toBe("rotated");
			expect(vault.value("token", { actor: "test", action: "used" })).toBe("bbbbbb-2222");
			expect(auditOf(db, "token")).toEqual([
				{ action: "put", preImage: { name: "token", key_version: 1 } },
				{ action: "rotated", preImage: { name: "token", kind: "password", mask: "aaa…1111", fingerprint: expect.any(String), key_version: 1 } },
				{ action: "used", preImage: { name: "token", key_version: null } },
			]);
			// The pre-image is identity and a mask, never the old plaintext: that is what makes an audit
			// row safe to show in a UI.
			const pre = db.prepare("SELECT pre_image FROM secret_audit ORDER BY id DESC LIMIT 1").get() as { pre_image: string };
			expect(pre.pre_image).not.toContain("aaaaaa-1111");
		} finally {
			dispose();
		}
	});

	it("keeps the metadata when only the value changes, and refuses a name that is not there", () => {
		const { vault, dispose } = tempVault();
		try {
			vault.put({ name: "token", value: "aaaaaa-1111", kind: "password", meta: { scope: "read" }, actor: "test" });
			vault.rotate({ name: "token", value: "bbbbbb-2222", actor: "test" });
			expect(vault.row("token")!.meta).toEqual({ scope: "read" });
			expect(vault.rotate({ name: "ghost", value: "cccccc-3333", actor: "test" })).toEqual({ status: "not found", name: "ghost" });
		} finally {
			dispose();
		}
	});
});

describe("deleting", () => {
	it("tombstones, still reports the row, and can be undone", () => {
		const { vault, dispose } = tempVault();
		try {
			vault.put({ name: "old", value: "aaaaaa-1111", actor: "test" });
			expect(vault.remove("old", { actor: "test", reason: "revoked" }).status).toBe("deleted");
			expect(vault.list()).toEqual([]);
			expect(vault.list("", true).map((row) => row.status)).toEqual(["deleted"]);
			// The point of a tombstone: the value is still there to put back, and the user never had to hold it.
			expect(vault.restore("old", { actor: "test" }).status).toBe("restored");
			expect(vault.value("old", { actor: "test", action: "used" })).toBe("aaaaaa-1111");
			expect(auditOf(vault.db, "old").map((row) => row.action)).toEqual(["put", "deleted", "restored", "used"]);
			expect(vault.remove("nothing", { actor: "test" })).toEqual({ status: "not found", name: "nothing" });
			expect(vault.restore("nothing", { actor: "test" })).toEqual({ status: "not found", name: "nothing" });
		} finally {
			dispose();
		}
	});

	it("lets a name be reused after a tombstone, by a different value", () => {
		const { vault, dispose } = tempVault();
		try {
			vault.put({ name: "key", value: "aaaaaa-1111", actor: "test" });
			vault.remove("key", { actor: "test" });
			expect(vault.put({ name: "key", value: "bbbbbb-2222", actor: "test" }).status).toBe("stored");
			expect(vault.list().map((row) => row.name)).toEqual(["key"]);
		} finally {
			dispose();
		}
	});
});

describe("search and uses", () => {
	it("finds by name and by metadata, never by value", () => {
		const { vault, dispose } = tempVault();
		try {
			vault.put({ name: "github_token", value: "ghp_aaaaaa1111", kind: "password", meta: { scope: "repo" }, actor: "test" });
			vault.put({ name: "openai_key", value: "sk-cccccc2222", kind: "password", actor: "test" });
			expect(vault.list("git").map((row) => row.name)).toEqual(["github_token"]);
			expect(vault.list("scope").map((row) => row.name)).toEqual(["github_token"]);
			expect(vault.list("").map((row) => row.name)).toEqual(["github_token", "openai_key"]);
		} finally {
			dispose();
		}
	});
});

describe("key rotation", () => {
	it("reports the rows that are still sealed under an older key, and queues the work", () => {
		const { vault, db, paths, dispose } = tempVault();
		try {
			vault.put({ name: "one", value: "aaaaaa-1111", actor: "test" });
			expect(vault.keyDrift()).toMatchObject({ keyProvider: "keyfile", current: 1, rows: 1, stale: 0, reencryptQueued: false });

			const rotated = vault.rotateKey("test");
			expect(rotated.version).toBe(2);
			expect(vault.keyDrift()).toMatchObject({ current: 2, stale: 1, reencryptQueued: true });
			expect(openJobs(db)).toEqual([REENCRYPT_JOB]);
			// Nothing moved yet, and nothing had to: re-sealing a vault is background work, not a CLI stall.
			expect(vault.value("one", { actor: "test", action: "used" })).toBe("aaaaaa-1111");

			expect(vault.reencrypt()).toEqual({ rows: 1, keyVersion: 2 });
			expect(vault.keyDrift()).toMatchObject({ current: 2, stale: 0 });
			expect(vault.value("one", { actor: "test", action: "used" })).toBe("aaaaaa-1111");
			expect(auditOf(db, "one").map((row) => row.action)).toContain("reencrypt");
			// The old key is only forgotten once no row needs it.
			expect(keyfileOf(paths.secretKeyPath).key(1)).toBeUndefined();
		} finally {
			dispose();
		}
	});

	it("queues the same job once, bringing it forward rather than adding a second copy", () => {
		const { vault, db, dispose } = tempVault();
		try {
			vault.queueReencrypt("first");
			vault.queueReencrypt("second");
			expect(openJobs(db)).toEqual([REENCRYPT_JOB]);
		} finally {
			dispose();
		}
	});

	it("refuses to re-encrypt a row whose key is gone, instead of losing it quietly", () => {
		const dirVault = tempVault();
		try {
			dirVault.vault.put({ name: "one", value: "aaaaaa-1111", actor: "test" });
			dirVault.vault.rotateKey("test");
			// Forget v1 before the rows moved: the state a crash between rotate and reencrypt can leave.
			keyfileOf(dirVault.paths.secretKeyPath).retain([2]);
			expect(() => dirVault.vault.reencrypt()).toThrow(/no key v1 for "one"/);
			expect(dirVault.vault.activeValues()).toEqual([]);
		} finally {
			dirVault.dispose();
		}
	});

	it("refuses to answer a reveal whose key is gone", () => {
		const dirVault = tempVault();
		try {
			dirVault.vault.put({ name: "one", value: "aaaaaa-1111", actor: "test" });
			dirVault.vault.rotateKey("test");
			keyfileOf(dirVault.paths.secretKeyPath).retain([2]);
			// An empty answer would be a wrong answer: the value exists, this process cannot read it.
			expect(() => dirVault.vault.value("one", { actor: "test", action: "revealed" })).toThrow(/no key v1 for "one"/);
		} finally {
			dirVault.dispose();
		}
	});

	it("a second process opens the same key file at the same version", () => {
		const { vault, paths, dispose } = tempVault();
		try {
			vault.put({ name: "one", value: "aaaaaa-1111", actor: "test" });
			const again = keyfileOf(paths.secretKeyPath);
			expect(again.currentVersion()).toBe(1);
			expect(Buffer.from(again.key(1)!)).toHaveLength(KEY_BYTES);
			expect(statSync(paths.secretKeyPath).mode & 0o777).toBe(0o600);
		} finally {
			dispose();
		}
	});
});

const keyfileOf = (file: string) => keyfileProvider(file);
function openJobs(db: import("node:sqlite").DatabaseSync): string[] {
	return (db.prepare("SELECT kind FROM jobs WHERE kind = ? AND locked_by IS NULL").all(REENCRYPT_JOB) as { kind: string }[]).map((row) => row.kind);
}
