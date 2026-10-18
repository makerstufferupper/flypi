import { describe, expect, it } from "vitest";
import { modelProgress } from "../../src/memory/progress.ts";

const MB = 1024 * 1024;

describe("model download progress", () => {
	it("prints the aggregate only, throttled, never backwards, and always the end", () => {
		const lines: string[] = [];
		const onProgress = modelProgress("onnx-community/embeddinggemma-2-ONNX", (line) => lines.push(line));
		for (const event of [
			{ status: "initiate", file: "model.onnx" },
			// Per-file events are ignored: a model is several files and they interleave.
			{ status: "progress", file: "model.onnx", progress: 5, loaded: 50 * MB, total: 1000 * MB },
			{ status: "progress_total", progress: 5, loaded: 50 * MB, total: 1000 * MB },
			{ status: "progress_total", progress: 6, loaded: 60 * MB, total: 1000 * MB }, // inside the throttle window
			{ status: "progress_total", progress: 100, loaded: 1000 * MB, total: 1000 * MB },
			{ status: "progress_total", progress: 100, loaded: 1000 * MB, total: 1000 * MB },
			{ status: "done", file: "model.onnx" },
		]) {
			onProgress(event);
		}
		expect(lines).toEqual([
			"flypi: downloading onnx-community/embeddinggemma-2-ONNX: 50/1000 MB (5%)",
			"flypi: downloading onnx-community/embeddinggemma-2-ONNX: 1000/1000 MB (100%)",
		]);
	});

	it("says so once when the weights are already on disk", () => {
		const lines: string[] = [];
		const onProgress = modelProgress("m", (line) => lines.push(line));
		onProgress({ status: "progress_total", progress: 100, loaded: 600 * MB, total: 600 * MB });
		onProgress({ status: "progress_total", progress: 100, loaded: 600 * MB, total: 600 * MB });
		expect(lines).toEqual(["flypi: downloading m: 600/600 MB (100%)"]);
	});
});
