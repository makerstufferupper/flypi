/**
 * Model-download progress (docs/architecture.md Phase 7). A first run fetches ~1 GB of ONNX weights before
 * the daemon is listening, which looks exactly like a hang from the outside — so every loader takes a
 * callback, and this turns what transformers.js reports into one readable line.
 */

/** transformers.js's `progress_callback` payload. `AutoModel.from_pretrained` wraps a plain function, so the
 * aggregate `progress_total` events (all files of the model together) arrive without any wrapping here. */
export interface ModelProgress {
	status: string;
	name?: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/**
 * A callback that logs one line per model: at most twice a second, never going backwards, and always the
 * final 100%. The per-file events are ignored on purpose — a model is several files, and interleaving them
 * in a detached daemon's log is unreadable. Weights already on disk report 100% at once, which is the
 * honest answer for "nothing to download".
 */
export function modelProgress(model: string, log: (line: string) => void = console.log): (progress: ModelProgress) => void {
	let shown = -1;
	let at = 0;
	return (progress) => {
		if (progress.status !== "progress_total" || typeof progress.progress !== "number") return;
		const percent = Math.floor(progress.progress);
		if (percent <= shown) return;
		const now = Date.now();
		if (percent < 100 && now - at < 500) return;
		shown = percent;
		at = now;
		log(`flypi: downloading ${model}: ${mb(progress.loaded ?? 0)}/${mb(progress.total ?? 0)} MB (${percent}%)`);
	};
}
