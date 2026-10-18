/**
 * The stub model seam (docs/testing.md): a deterministic fake pi model with scripted
 * tool calls and streamed deltas. Every phase above Phase 0 is tested against this —
 * no paid provider, no network, no flaky prompt.
 *
 * pi ships the fake (`fauxProvider` in @earendil-works/pi-ai); this file only points it
 * at a `ModelRuntime` that reads no config and reaches no network.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type FauxProviderHandle,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";

export const STUB_PROVIDER = "flypi-stub";
export const STUB_MODEL_ID = "stub";

export interface StubModel {
	modelRuntime: ModelRuntime;
	model: ReturnType<FauxProviderHandle["getModel"]>;
	/**
	 * Every model request the stub was asked to answer, in order. What a test asserts against when the
	 * question is "did this reach the model" rather than "what did the model say".
	 */
	requests: { messages: unknown[] }[];
	/** Script the model's next replies. Later phases reuse this. */
	script(responses: FauxResponseStep[]): void;
	append(responses: FauxResponseStep[]): void;
	faux: FauxProviderHandle;
}

/**
 * @param responses optional script, consumed one assistant message per model call.
 * @param authPath credential file to use instead of the host `~/.pi/agent/auth.json`.
 */
export async function createStubModel(options: {
	responses?: FauxResponseStep[];
	authPath?: string;
	tokensPerSecond?: number;
} = {}): Promise<StubModel> {
	const faux = fauxProvider({
		provider: STUB_PROVIDER,
		models: [
			{
				id: STUB_MODEL_ID,
				name: "Flypi stub model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			},
		],
		// Streaming is what the WS bridge is for: force real deltas, not one chunk.
		tokensPerSecond: options.tokensPerSecond ?? 100_000,
	});
	const requests: { messages: unknown[] }[] = [];
	const modelRuntime = await ModelRuntime.create({
		modelsPath: null,
		authPath: options.authPath,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(recordingProvider(faux.provider, requests));
	faux.setResponses(options.responses ?? []);
	const model = faux.getModel();
	if (!model) throw new Error("stub model provider registered no model");
	return { modelRuntime, model, requests, faux, script: (r) => faux.setResponses(r), append: (r) => faux.appendResponses(r) };
}

/** The provider with its calls recorded: the payload pi sends is what a recall test has to see. */
function recordingProvider(provider: FauxProviderHandle["provider"], requests: { messages: unknown[] }[]) {
	const record = (args: unknown[]) => {
		const context = args.find((arg) => typeof arg === "object" && arg !== null && Array.isArray((arg as { messages?: unknown }).messages));
		if (context) requests.push(context as { messages: unknown[] });
	};
	return {
		...provider,
		stream: (...args: Parameters<typeof provider.stream>) => {
			record(args);
			return provider.stream(...args);
		},
		streamSimple: (...args: Parameters<typeof provider.streamSimple>) => {
			record(args);
			return provider.streamSimple(...args);
		},
	};
}

export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall };
export type { FauxResponseStep };
