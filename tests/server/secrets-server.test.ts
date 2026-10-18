/**
 * The Secrets tab's wire (docs/secrets.md Phase 5.5, docs/protocol.md). Driven by a scripted WS client
 * against a real vault, because the promise the UI depends on is a property of the frames: a snapshot never
 * carries a value, only an explicit reveal does, and a process with no vault says so instead of returning an
 * empty list that would look like an empty vault.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { flypiPaths } from "../../src/agent/paths.ts";
import { openMemoryDb } from "../../src/memory/db.ts";
import { openSecretVault } from "../../src/secrets/vault.ts";
import { startFlypiServer, type FlypiServerHandle } from "../../src/server/index.ts";
import { secretsApi } from "../../src/server/secrets-api.ts";
import { checkServerFrame, type ClientCommand, type SecretsSnapshot, type ServerFrame } from "../../src/server/protocol.ts";
import { harness, toolTurn } from "../helpers/flypi-harness.ts";

const TOKEN = "ghp_AAAAAAAAAAAAAAAAAA11111111";

function connect(url: string, token: string) {
	const socket = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	const frames: ServerFrame[] = [];
	let cursor = 0;
	socket.on("message", (raw) => {
		const frame = JSON.parse(String(raw)) as ServerFrame;
		// Every frame has to satisfy its own schema — the client renders straight from these.
		expect(checkServerFrame(frame).ok, `server sent a frame that violates its own schema: ${String(raw)}`).toBe(true);
		frames.push(frame);
	});
	const opened = new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return opened.then(() => ({
		raw: () => frames.map((frame) => JSON.stringify(frame)).join("\n"),
		send: (command: ClientCommand) => socket.send(JSON.stringify(command)),
		for: (requestId: string) =>
			new Promise<ServerFrame>((resolve, reject) => {
				const deadline = Date.now() + 5_000;
				const poll = () => {
					for (let i = cursor; i < frames.length; i += 1) {
						const frame = frames[i]!;
						if (("requestId" in frame ? frame.requestId : undefined) === requestId) {
							cursor = i + 1;
							return resolve(frame);
						}
					}
					if (Date.now() > deadline) return reject(new Error(`no reply to ${requestId}; got ${frames.map((f) => f.type).join(",")}`));
					setTimeout(poll, 5);
				};
				poll();
			}),
		close: () => new Promise<void>((resolve) => {
			socket.once("close", () => resolve());
			socket.close();
		}),
	}));
}

async function startVaultedServer() {
	const h = await harness(toolTurn());
	const paths = flypiPaths(h.root);
	// A reference in a real config file: deleting the name it points at has to be visible as a consequence.
	writeFileSync(
		paths.mcpPath,
		JSON.stringify({ mcpServers: { github: { url: "https://api.github.com/mcp", headers: { Authorization: `Bearer !flypi secret print github_token` } } } }),
	);
	const db = openMemoryDb(paths.memoryDbPath);
	const vault = openSecretVault(paths, { db, write: true });
	vault.put({ name: "github_token", value: TOKEN, kind: "password", meta: { scope: "repo" }, actor: "test" });
	vault.put({ name: "pin", value: "1234", kind: "password", actor: "test" });
	const server = await startFlypiServer({ registry: h.registry, secrets: secretsApi(vault, paths) });
	return {
		server,
		vault,
		client: () => connect(server.url, server.token),
		dispose: async () => {
			await server.close();
			vault.close();
			db.close();
			h.registry.dispose();
			h.cleanup();
		},
	};
}

describe("the Secrets wire", () => {
	it("answers `secrets` with masks, references and key state — never a value", async () => {
		const started = await startVaultedServer();
		try {
			const client = await started.client();
			client.send({ type: "secrets", requestId: "r1" });
			const frame = await client.for("r1");
			expect(frame.type).toBe("result");
			const snapshot = (frame as { secrets?: SecretsSnapshot }).secrets!;
			expect(snapshot.secrets.map((row) => [row.name, row.kind, row.mask, row.status])).toEqual([
				["github_token", "password", "ghp…1111", "active"],
				["pin", "password", "•••••", "active"],
			]);
			expect(snapshot.secrets[0]!.meta).toEqual({ scope: "repo" });
			expect(snapshot.secrets[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
			expect(snapshot.key).toMatchObject({ provider: "keyfile", currentVersion: 1, rows: 2, stale: 0, reencryptQueued: false });
			expect(snapshot.references).toEqual([{ file: "mcp.json", path: "mcp.json.mcpServers.github.headers.Authorization", name: "github_token" }]);
			// The gap in redaction, reported rather than hidden: a four-character value is not matched in text.
			expect(snapshot.tooShortToRedact).toEqual(["pin"]);
			// And the claim the whole tab rests on, checked against the bytes on the wire.
			expect(client.raw()).not.toContain(TOKEN);
			await client.close();
		} finally {
			await started.dispose();
		}
	});

	it("applies edits and returns the refreshed snapshot", async () => {
		const started = await startVaultedServer();
		try {
			const client = await started.client();
			client.send({
				type: "saveSecrets",
				secrets: [
					{ name: "github_token", value: "ghp_BBBBBBBBBBBBBB22222222", kind: "password" },
					{ name: "new_one", value: "cccccccc-3333", kind: "password" },
					{ name: "pin", remove: true },
				],
				requestId: "r2",
			});
			const frame = await client.for("r2");
			const snapshot = (frame as { secrets?: SecretsSnapshot }).secrets!;
			expect(snapshot.secrets.map((row) => [row.name, row.status])).toEqual([
				["github_token", "active"],
				["new_one", "active"],
				["pin", "deleted"],
			]);
			expect(started.vault.value("github_token", { actor: "test", action: "used" })).toBe("ghp_BBBBBBBBBBBBBB22222222");
			await client.close();
		} finally {
			await started.dispose();
		}
	});

	it("refuses an edit that cannot be made, and says which one", async () => {
		const started = await startVaultedServer();
		try {
			const client = await started.client();
			// The same value under a second name: the vault refuses it, because a list of two names for one
			// credential is how a rotation later misses half of them.
			client.send({ type: "saveSecrets", secrets: [{ name: "github_backup", value: TOKEN }], requestId: "r3" });
			const duplicate = await client.for("r3");
			expect(duplicate.type).toBe("error");
			expect((duplicate as { message: string }).message).toContain('already stored as "github_token"');
			client.send({ type: "saveSecrets", secrets: [{ name: "never-had", remove: true }], requestId: "r4" });
			expect((await client.for("r4") as { message: string }).message).toContain('no secret named "never-had"');
			client.send({ type: "saveSecrets", secrets: [{ name: "nothing_to_store" }], requestId: "r5" });
			expect((await client.for("r5") as { message: string }).message).toContain("nothing to store");
			// The undo a tombstone makes possible: the page never held the value, so it asks for the name.
			client.send({ type: "saveSecrets", secrets: [{ name: "pin", remove: true }, { name: "pin", restore: true }], requestId: "r6" });
			expect((await client.for("r6") as { secrets?: SecretsSnapshot }).secrets!.secrets.find((row) => row.name === "pin")!.status).toBe("active");
			client.send({ type: "saveSecrets", secrets: [{ name: "never-deleted", restore: true }], requestId: "r7" });
			expect((await client.for("r7") as { message: string }).message).toContain('nothing deleted named "never-deleted"');
			await client.close();
		} finally {
			await started.dispose();
		}
	});

	it("reveals one value by name, and that is the only plaintext on the wire", async () => {
		const started = await startVaultedServer();
		try {
			const client = await started.client();
			client.send({ type: "revealSecret", name: "github_token", requestId: "r6" });
			const frame = await client.for("r6");
			expect((frame as { revealed?: { name: string; value: string } }).revealed).toEqual({ name: "github_token", value: TOKEN });
			expect(client.raw()).toContain(TOKEN);
			// The reveal is an event in the vault's own history, because "when was this used" is a question a
			// person asks about a credential.
			expect(started.vault.uses("github_token").map((use) => use.action)).toContain("revealed");
			client.send({ type: "revealSecret", name: "nope", requestId: "r7" });
			expect((await client.for("r7") as { message: string }).message).toContain('no secret named "nope"');
			await client.close();
		} finally {
			await started.dispose();
		}
	});

	it("a process with no vault says so, rather than showing an empty one", async () => {
		const h = await harness(toolTurn());
		const server = await startFlypiServer({ registry: h.registry });
		try {
			const client = await connect(server.url, server.token);
			const commands: [ClientCommand, string][] = [
				[{ type: "secrets", requestId: "r8" }, "r8"],
				[{ type: "saveSecrets", secrets: [{ name: "x", value: "yyyyyy" }], requestId: "r9" }, "r9"],
				[{ type: "revealSecret", name: "x", requestId: "r10" }, "r10"],
			];
			for (const [command, requestId] of commands) {
				client.send(command);
				const frame = await client.for(requestId);
				expect(frame.type).toBe("error");
				expect((frame as { message: string }).message).toBe("this flypi process has no vault open");
			}
			await client.close();
		} finally {
			await server.close();
			h.cleanup();
		}
	});
});
