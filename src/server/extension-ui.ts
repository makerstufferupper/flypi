/**
 * The bridge between an extension's `ctx.ui` and the browser (docs/protocol.md `extensionUi`).
 *
 * pi hands every extension a UI context, and a headless session gets a no-op one — so an extension
 * command that answers with `ctx.ui.notify(...)` or asks with `ctx.ui.select(...)` would say nothing at
 * all in flypi's chat. One bridge per conversation: the four calls a browser can serve become frames,
 * and a question waits for the page's `extensionReply`.
 *
 * Everything else on that interface is terminal-only — widgets, footers, themes, raw input, the custom
 * component escape hatch. They stay no-ops, so an extension that calls one gets "nothing happened"
 * instead of an exception in the middle of its handler.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiFrame } from "./protocol.ts";

/** The frame body; the WS layer puts `type` and the conversation's id on it. */
export type ExtensionUiPush = (frame: Omit<ExtensionUiFrame, "type" | "conversationId">) => void;

export interface ExtensionUiBridge {
	/** Pass to `bindExtensions` for this conversation. */
	uiContext: ExtensionUIContext;
	/** The page answered. False when nothing waits on that id — already answered, timed out, or gone. */
	reply(dialogId: string, value: string | null): boolean;
	/** The conversation is going away: release every handler still waiting rather than hang on a closed tab. */
	close(): void;
}

/** Nobody answers a dialog for this long, so the extension is told it was cancelled, as a dismissed TUI dialog would be. */
const DIALOG_TIMEOUT_MS = 5 * 60_000;

export function createExtensionUiBridge(push: ExtensionUiPush): ExtensionUiBridge {
	const waiting = new Map<string, (value: string | null) => void>();

	/** One question, one id, one answer: null means cancelled (dismissed, aborted, or nobody answered). */
	const ask = (
		kind: "select" | "confirm" | "input",
		title: string,
		message: string,
		options: ExtensionUIDialogOptions | undefined,
		choices: string[] | undefined,
	): Promise<string | null> =>
		new Promise((resolve) => {
			const dialogId = randomUUID();
			const settle = (value: string | null) => {
				waiting.delete(dialogId);
				clearTimeout(timer);
				options?.signal?.removeEventListener("abort", cancel);
				resolve(value);
			};
			const cancel = () => settle(null);
			const timer = setTimeout(settle, DIALOG_TIMEOUT_MS, null);
			timer.unref();
			waiting.set(dialogId, settle);
			// pi passes a signal when it wants the question dismissed — an aborted turn, or its own timeout.
			if (options?.signal) {
				if (options.signal.aborted) return settle(null);
				options.signal.addEventListener("abort", cancel, { once: true });
			}
			push({ kind, title, message, dialogId, ...(choices ? { options: choices } : {}) });
		});

	const uiContext = {
		...terminalOnlyUi,
		notify: (message: string, level?: "info" | "warning" | "error") =>
			push({ kind: "notify", message, ...(level ? { level } : {}) }),
		select: async (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
			(await ask("select", title, "", opts, options)) ?? undefined,
		confirm: async (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
			(await ask("confirm", title, message, opts, undefined)) !== null,
		input: async (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
			(await ask("input", title, placeholder ?? "", opts, undefined)) ?? undefined,
	} as unknown as ExtensionUIContext; // `theme` is the one member left absent: there is no terminal palette to hand out

	return {
		uiContext,
		reply: (dialogId, value) => {
			const settle = waiting.get(dialogId);
			if (!settle) return false;
			settle(value);
			return true;
		},
		close: () => {
			for (const settle of waiting.values()) settle(null);
		},
	};
}

/**
 * The terminal half of `ExtensionUIContext`, answered the way pi's own no-op context answers it.
 * `theme` is left out entirely: flypi has no terminal theme to hand out, and an extension only reads it
 * inside a `ctx.mode === "tui"` branch, which this session never enters.
 */
const terminalOnlyUi = {
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWorkingVisible: () => {},
	setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	pasteToEditor: () => {},
	setEditorText: () => {},
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	getEditorText: () => "",
	getEditorComponent: () => undefined,
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: () => ({ success: false, error: "flypi has no theme UI" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
	custom: async () => undefined,
	editor: async () => undefined,
} satisfies Partial<Record<keyof ExtensionUIContext, unknown>>;
