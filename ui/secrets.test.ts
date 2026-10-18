/**
 * The Secrets tab (docs/secrets.md Phase 5.5). What is asserted here is the page's half of the design: the
 * vault is a view of its own that replaces the chat, the list is masks, a value appears only after an explicit
 * click and stops appearing by itself, a write sends one entry rather than the panel's contents, a delete leaves
 * a row that can be restored, and the two gaps (a value too short to redact, a row sealed under an older key)
 * are said rather than hidden. What the vault does with those writes is covered in tests/secrets/.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import App from "./App.svelte";
import type { ClientCommand, SecretEdit, SecretsSnapshot, ServerFrame } from "../src/server/protocol.ts";
import type { Transport } from "./lib/client.ts";

class FakeTransport implements Transport {
	sent: ClientCommand[] = [];
	#handlers = new Set<(signal: ServerFrame | { type: "connected" } | { type: "disconnected" }) => void>();

	on(handler: (signal: ServerFrame | { type: "connected" } | { type: "disconnected" }) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	send(command: ClientCommand): void {
		this.sent.push(command);
	}

	emit(signal: Parameters<Parameters<Transport["on"]>[0]>[0]): void {
		for (const handler of this.#handlers) handler(signal);
	}
}

const VALUE = "sk-or-vl-3f9a71b0c2d4";

const SNAPSHOT: SecretsSnapshot = {
	secrets: [
		{
			id: 1,
			name: "langfuse_key",
			kind: "password",
			mask: "sk-or-…c2d4",
			meta: { host: "langfuse.example", provider_url: "https://langfuse.example" },
			status: "active",
			createdAt: "2026-09-01T09:00:00.000Z",
			lastUsedAt: "2026-10-04T18:20:00.000Z",
			useCount: 7,
			keyVersion: 2,
			fingerprint: "9c1f0a4b7d2e5c8a1b3f",
		},
		{
			id: 2,
			name: "router_admin",
			kind: "password",
			mask: "••••••••",
			meta: { host: "192.168.1.1", username: "admin" },
			status: "active",
			createdAt: "2026-08-11T07:30:00.000Z",
			useCount: 0,
			// Sealed under the key that was current before the last rotation: the drift the panel has to say.
			keyVersion: 1,
			fingerprint: "1a2b3c4d5e6f708192a3",
		},
		{
			id: 3,
			name: "mats_ssh",
			kind: "ssh_private_key",
			mask: "ed25519 SHA256:7f3a",
			meta: { path: "/Users/mats/.ssh/id_ed25519" },
			status: "deleted",
			createdAt: "2026-07-02T10:00:00.000Z",
			useCount: 3,
			keyVersion: 2,
			fingerprint: "7f3a9c0d1e2f3a4b5c6d",
		},
	],
	references: [
		{ file: "auth.json", path: "anthropic.key", name: "anthropic_key" },
		{ file: "mcp.json", path: "langfuse.headers.Authorization", name: "langfuse_key" },
	],
	key: { provider: "keyfile", currentVersion: 2, rows: 3, stale: 1, reencryptQueued: false },
	tooShortToRedact: ["garage_pin"],
};

async function mount(): Promise<FakeTransport> {
	const transport = new FakeTransport();
	render(App, { props: { transport } });
	await tick();
	transport.emit({ type: "connected" });
	await tick();
	return transport;
}

/** The key in the sidebar, then the snapshot the vault answers with. */
async function openVault(transport: FakeTransport, secrets: SecretsSnapshot = SNAPSHOT): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: /^secrets$/i }));
	await tick();
	transport.emit({ type: "result", requestId: lastRequestId(transport, "secrets"), secrets });
	await tick();
}

const sent = (transport: FakeTransport, type: string) => transport.sent.filter((c) => c.type === type);
/** The request id the app generated for its last ask of this kind — an answer or a refusal must carry it. */
const lastRequestId = (transport: FakeTransport, type: string) =>
	(sent(transport, type).at(-1) as { requestId?: string }).requestId ?? "";
const edits = (transport: FakeTransport): SecretEdit[] =>
	transport.sent.flatMap((c) => (c.type === "saveSecrets" ? c.secrets : []));

const view = () => document.querySelector('[data-role="secrets-view"]');
const row = (name: string) =>
	[...document.querySelectorAll('[data-role="secret"]')].find((el) => el.querySelector('[data-role="secret-name"]')?.textContent === name) as HTMLElement;
const form = () => document.querySelector('[data-role="secret-form"]') as HTMLFormElement;
const field = (name: string) => form().querySelector(`[name="${name}"]`) as HTMLInputElement;

async function type(name: string, value: string): Promise<void> {
	fireEvent.input(field(name), { target: { value } });
	await tick();
}

/**
 * Choose an option in a select. happy-dom has no `:checked` for `<option>`, and Svelte's select binding reads
 * `:checked` and otherwise falls back to the first option that is not disabled — so everything before the wanted
 * option is disabled for the duration of the event, which is self-correcting because every call re-decides.
 * shortcut: only the test environment needs the disabled dance; once happy-dom matches `:checked` for options
 * this collapses to `select.value = value; fireEvent.change(select)`.
 */
async function choose(name: string, value: string): Promise<void> {
	const select = form().querySelector(`[name="${name}"]`) as HTMLSelectElement;
	for (const option of select.options) {
		option.selected = option.value === value;
		option.disabled = option.value !== value;
	}
	fireEvent.change(select);
	await tick();
}

/** Click a row's action by its `data-role`, which is how a test names a glyph without naming its pixels. */
async function clickIn(scope: HTMLElement, role: string): Promise<void> {
	fireEvent.click(scope.querySelector(`[data-role="${role}"]`) as HTMLElement);
	await tick();
}

// An address bar left over from one test would open the next one in the wrong view, because a URL naming a
// view is honoured at mount. And a fake clock left running would stop the next test's reveal from being real.
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	history.replaceState(null, "", "/");
});

describe("the Secrets view", () => {
	it("replaces the chat, and the address bar says so; the way back puts the chat back", async () => {
		history.replaceState(null, "", "/");
		const transport = await mount();
		expect(document.querySelector(".chat")).toBeTruthy();
		expect(location.pathname).toBe("/");

		await openVault(transport);
		// The vault is about the agent's credentials, not this conversation: the transcript is not on screen
		// next to a revealed value, because that would be a second place the value is written.
		expect(document.querySelector(".chat")).toBeNull();
		expect(document.querySelector(".activity-panel")).toBeNull();
		expect(view()).toBeTruthy();
		expect(document.querySelector(".sidebar")).toBeTruthy();
		expect(location.pathname).toBe("/secrets");

		fireEvent.click(screen.getByRole("button", { name: /back to chat/i }));
		await tick();
		expect(document.querySelector(".chat")).toBeTruthy();
		expect(view()).toBeNull();
		expect(location.pathname).toBe("/");
	});

	it("opens where the address bar says, and asks for the vault then — once", async () => {
		history.replaceState(null, "", "/secrets");
		const transport = await mount();
		expect(view()).toBeTruthy();
		// Asked when the view opens, never on a timer: a snapshot is a read of the vault, and a vault is small.
		expect(sent(transport, "secrets")).toHaveLength(1);
	});

	it("lists masks, uses and notes — never a value", async () => {
		const transport = await mount();
		await openVault(transport);
		expect(row("langfuse_key").textContent).toContain("sk-or-…c2d4");
		expect(row("langfuse_key").textContent).toContain("used 7×");
		expect(row("langfuse_key").textContent).toContain("host=langfuse.example");
		expect(row("router_admin").textContent).toContain("••••••••");
		expect(row("router_admin").textContent).toContain("never used");
		// There is no value to hide here: the snapshot's row type has no value field at all, and the mask is
		// what every read path returns (src/server/secrets-api.ts). A row's own text is still worth asserting.
		expect(document.body.textContent).not.toContain(VALUE);
		// And a tombstone is not mixed in with the live rows: it is listed where it can be restored.
		expect(row("mats_ssh")).toBeUndefined();
		expect(document.querySelector('[data-role="deleted-secret"]')?.textContent).toContain("mats_ssh");
	});

	it("shows a value only when it is asked for, copies that one, and hides it again by itself", async () => {
		// The clock is fake before the value ever arrives, because the reveal's window starts when it does.
		vi.useFakeTimers();
		const transport = await mount();
		await openVault(transport);

		await clickIn(row("langfuse_key"), "secret-reveal");
		expect(sent(transport, "revealSecret")).toHaveLength(1);
		expect((sent(transport, "revealSecret")[0] as { name: string }).name).toBe("langfuse_key");

		transport.emit({ type: "result", requestId: lastRequestId(transport, "revealSecret"), revealed: { name: "langfuse_key", value: VALUE } });
		await tick();
		expect(row("langfuse_key").querySelector('[data-role="revealed-value"]')?.textContent).toBe(VALUE);

		const copied: string[] = [];
		Object.defineProperty(navigator, "clipboard", { value: { writeText: (text: string) => copied.push(text) }, configurable: true });
		await clickIn(row("langfuse_key"), "secret-copy");
		expect(copied).toEqual([VALUE]);

		// The window is the page's, and it closes on its own — "auto-rehide, never kept client-side".
		vi.advanceTimersByTime(30_000);
		await tick();
		expect(row("langfuse_key").querySelector('[data-role="revealed-value"]')).toBeNull();
		expect(row("langfuse_key").textContent).toContain("sk-or-…c2d4");
		expect(document.body.textContent).not.toContain(VALUE);
	});

	it("hides it now when told to", async () => {
		const transport = await mount();
		await openVault(transport);
		await clickIn(row("langfuse_key"), "secret-reveal");
		transport.emit({ type: "result", requestId: lastRequestId(transport, "revealSecret"), revealed: { name: "langfuse_key", value: VALUE } });
		await tick();
		await clickIn(row("langfuse_key"), "secret-hide");
		expect(document.body.textContent).not.toContain(VALUE);
	});

	it("leaves no value behind when the view is left", async () => {
		const transport = await mount();
		await openVault(transport);
		await clickIn(row("langfuse_key"), "secret-reveal");
		transport.emit({ type: "result", requestId: lastRequestId(transport, "revealSecret"), revealed: { name: "langfuse_key", value: VALUE } });
		await tick();
		fireEvent.click(screen.getByRole("button", { name: /back to chat/i }));
		await tick();
		// Back in the vault, the same row is a mask again: the plaintext had no reason to outlive the view.
		await openVault(transport);
		expect(document.body.textContent).not.toContain(VALUE);
	});

	it("sends one entry when adding a secret, with its notes, and shows the mask that comes back", async () => {
		const transport = await mount();
		await openVault(transport);
		fireEvent.click(screen.getByRole("button", { name: /^add secret$/i }));
		await tick();
		await type("name", "anthropic_key");
		await type("value", VALUE);
		await type("meta", "provider=anthropic\nhost=api.anthropic.com");
		fireEvent.submit(form());
		await tick();

		expect(edits(transport)).toEqual([{ name: "anthropic_key", kind: "password", value: VALUE, meta: { provider: "anthropic", host: "api.anthropic.com" } }]);
		// The value went out in that frame and did not come back: the ack is a snapshot of masks.
		transport.emit({
			type: "result",
			requestId: lastRequestId(transport, "saveSecrets"),
			secrets: {
				...SNAPSHOT,
				secrets: [
					...SNAPSHOT.secrets,
					// What the vault answers with: the new row, masked. The value is not in this frame.
					{
						id: 4,
						name: "anthropic_key",
						kind: "password",
						mask: "sk-…b0c2",
						meta: { provider: "anthropic" },
						status: "active",
						createdAt: "2026-10-09T10:00:00.000Z",
						useCount: 0,
						keyVersion: 2,
						fingerprint: "0011223344556677",
					},
				],
			}
		});
		await tick();
		expect(row("anthropic_key").textContent).toContain("sk-…b0c2");
		expect(document.body.textContent).not.toContain(VALUE);
	});

	it("refuses to store a secret with no value, and says so in the modal", async () => {
		const transport = await mount();
		await openVault(transport);
		fireEvent.click(screen.getByRole("button", { name: /^add secret$/i }));
		await tick();
		await type("name", "anthropic_key");
		fireEvent.submit(form());
		await tick();
		expect(edits(transport)).toEqual([]);
		expect(document.querySelector('[data-role="form-error"]')?.textContent).toContain("a value");
	});

	it("gives a key or a yaml document a multiline value box, and one line to everything else", async () => {
		const transport = await mount();
		const KUBECONFIG = "apiVersion: v1\nkind: Config\nclusters:\n  - name: home\n    server: https://192.168.1.10:6443\n";
		await openVault(transport);
		fireEvent.click(screen.getByRole("button", { name: /^add secret$/i }));
		await tick();
		const valueField = () => form().querySelector('[data-role="form-value"]') as HTMLElement;
		expect(valueField().tagName).toBe("INPUT");

		// The kind is what decides, so switching it mid-edit switches the box — a pasted blob has to be readable
		// to be checked, and a single-line input cannot show one.
		await choose("kind", "yaml");
		expect(valueField().tagName).toBe("TEXTAREA");
		await choose("kind", "ssh_private_key");
		expect(valueField().tagName).toBe("TEXTAREA");
		await choose("kind", "password");
		expect(valueField().tagName).toBe("INPUT");
		// One kind covers three shapes, and its label says "password" — so the box is where it says the rest.
		expect(field("value").placeholder).toContain("api key, token or password");

		// …and the blob still goes out as one value, newlines and the trailing newline included.
		await choose("kind", "yaml");
		await type("name", "kube_config");
		await type("value", KUBECONFIG);
		fireEvent.submit(form());
		await tick();
		expect(edits(transport)).toEqual([{ name: "kube_config", kind: "yaml", value: KUBECONFIG, meta: {} }]);
	});

	it("reads a note line it cannot parse and sends nothing", async () => {
		const transport = await mount();
		await openVault(transport);
		fireEvent.click(screen.getByRole("button", { name: /^add secret$/i }));
		await tick();
		await type("name", "anthropic_key");
		await type("value", VALUE);
		await type("meta", "anthropic");
		fireEvent.submit(form());
		await tick();
		expect(edits(transport)).toEqual([]);
		expect(document.querySelector('[data-role="form-error"]')?.textContent).toContain("name=value");
	});

	it("deletes into a tombstone and puts it back by name", async () => {
		const transport = await mount();
		await openVault(transport);
		await clickIn(row("router_admin"), "secret-remove");
		expect(edits(transport)).toEqual([{ name: "router_admin", remove: true }]);
		// The vault's answer: the row is still there, marked deleted — `select count(*)` never goes down.
		transport.emit({
			type: "result",
			requestId: lastRequestId(transport, "saveSecrets"),
			secrets: { ...SNAPSHOT, secrets: SNAPSHOT.secrets.map((row) => (row.name === "router_admin" ? { ...row, status: "deleted" as const } : row)) },
		});
		await tick();
		expect(row("router_admin")).toBeUndefined();
		const gone = document.querySelector('[data-role="deleted-secret"]') as HTMLElement;
		expect(gone.textContent).toContain("router_admin");
		// The undo is a Restore on the same name, not a value this page holds: the ciphertext was never thrown away.
		await clickIn(gone, "secret-restore");
		expect(edits(transport).at(-1)).toEqual({ name: "router_admin", restore: true });
	});

	it("lists the config entries that point at a name", async () => {
		const transport = await mount();
		await openVault(transport);
		const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
		const lines = [...document.querySelectorAll('[data-role="reference"]')];
		expect(lines.map(text)).toEqual([
			"auth.json · anthropic.key → anthropic_key",
			"mcp.json · langfuse.headers.Authorization → langfuse_key",
		]);
		// The other half of why this list exists: a rotated value only takes effect after a restart, because pi
		// runs `!flypi secret print` once per process. Stated, not left to be discovered.
		expect(text(document.querySelector('[data-role="references"]')?.parentElement)).toContain("flypi restart");
	});

	it("says which rows are sealed under an older key, and which values are too short to redact", async () => {
		const transport = await mount();
		await openVault(transport);
		expect(document.querySelector('[data-role="key-state"]')?.textContent).toContain("1 row is still sealed under an older key");
		expect(row("router_admin").querySelector('[data-role="key-drift"]')?.textContent).toContain("sealed under key v1");
		expect(document.querySelector('[data-role="short-warning"]')?.textContent).toContain("garage_pin");
	});

	it("says the one place a secret can still be seen, rather than pretending the redaction is total", async () => {
		const transport = await mount();
		await openVault(transport);
		expect(document.querySelector('[data-role="stream-caveat"]')?.textContent).toContain("on screen for a moment");
	});

	it("says a refusal from the vault in the panel that asked, and stops saying it when the vault answers", async () => {
		const transport = await mount();
		await openVault(transport);
		fireEvent.click(screen.getByRole("button", { name: /^add secret$/i }));
		await tick();
		await type("name", "langfuse_key");
		await type("value", "a different value for a name that is taken");
		fireEvent.submit(form());
		await tick();
		transport.emit({ type: "error", requestId: lastRequestId(transport, "saveSecrets"), message: '"langfuse_key" holds a different value — rotate it or choose another name' });
		await tick();
		// The vault's own words, in the panel: nothing on disk changed, and a list that still shows the old rows
		// would otherwise read as a save that worked (ui/lib/app-state.svelte.ts answers by request id).
		expect(document.querySelector('[data-role="save-error"]')?.textContent).toContain("holds a different value");
		expect(row("langfuse_key").textContent).toContain("sk-or-…c2d4");
		// A fresh snapshot is the truth about the vault, so the stale refusal goes away with it rather than
		// sitting above a list that no longer matches it.
		transport.emit({ type: "result", requestId: lastRequestId(transport, "secrets"), secrets: SNAPSHOT });
		await tick();
		expect(document.querySelector('[data-role="save-error"]')).toBeNull();
	});
});
