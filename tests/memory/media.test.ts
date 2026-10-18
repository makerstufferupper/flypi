import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AUDIO_RATE, decodeWav, readMedia } from "../../src/memory/media.ts";
import { pcmWav, sine } from "../helpers/wav.ts";

describe("media: what a memory is allowed to carry", () => {
	const dir = mkdtempSync(join(tmpdir(), "flypi-media-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("says what a file is, from the name it was given", async () => {
		writeFileSync(join(dir, "photo.PNG"), "bytes");
		writeFileSync(join(dir, "voice.wav"), "bytes");
		expect(await readMedia(join(dir, "photo.PNG"))).toMatchObject({ kind: "image", mime: "image/png" });
		expect(await readMedia(join(dir, "voice.wav"))).toMatchObject({ kind: "audio", mime: "audio/wav" });
	});

	it("refuses a format it cannot read, and says what to do about it", async () => {
		writeFileSync(join(dir, "voice.mp3"), "bytes");
		await expect(readMedia(join(dir, "voice.mp3"))).rejects.toThrow(/audio is wav \(re-encode the recording to wav\)/);
	});

	it("refuses an empty file rather than remembering nothing", async () => {
		writeFileSync(join(dir, "empty.png"), "");
		await expect(readMedia(join(dir, "empty.png"))).rejects.toThrow(/is empty/);
	});
});

describe("media: decoding audio far enough for the model", () => {
	it("reads 16-bit mono at 16 kHz back as the samples it was", () => {
		const input = sine(1600, 440);
		const decoded = decodeWav(pcmWav(input));
		expect(decoded.seconds).toBeCloseTo(0.1, 5);
		expect(decoded.samples.length).toBe(1600);
		for (let i = 0; i < input.length; i += 5) expect(decoded.samples[i]!).toBeCloseTo(input[i]!, 3);
	});

	/** The model's audio encoder is fed mono 16 kHz, and real recorders write anything else. */
	it("downmixes stereo and resamples 48 kHz to the 16 kHz the model wants", () => {
		const seconds = 0.4;
		const input = sine(Math.round(seconds * 48_000), 300, 48_000);
		const decoded = decodeWav(pcmWav(input, { rate: 48_000, channels: 2 }));
		expect(decoded.seconds).toBeCloseTo(seconds, 5);
		expect(decoded.samples.length).toBe(Math.round(seconds * AUDIO_RATE));
		// The pitch survives: 300 Hz crosses zero 600 times per second, which only the right rate gives.
		expect(zeroCrossingsPerSecond(decoded.samples)).toBeCloseTo(300, -1);
	});

	/** Sign changes, ignoring exact zeros — a naive comparison counts a crossing twice. */
	function zeroCrossingsPerSecond(samples: Float32Array): number {
		let sign = 0;
		let crossings = 0;
		for (const value of samples) {
			if (value === 0) continue;
			const next = Math.sign(value);
			if (sign !== 0 && next !== sign) crossings += 1;
			sign = next;
		}
		return crossings / 2 / (samples.length / AUDIO_RATE);
	}

	it("reads 8-bit unsigned and 32-bit float too, because recorders disagree", () => {
		const input = sine(800, 300);
		for (const bits of [8, 32] as const) {
			const decoded = decodeWav(pcmWav(input, { bits }));
			expect(decoded.samples.length).toBe(800);
			for (let i = 0; i < 800; i += 50) expect(decoded.samples[i]!).toBeCloseTo(input[i]!, bits === 8 ? 1 : 5);
		}
	});

	// The encoders a phone or a browser will hand you. Each one is a branch of `sampleAt`, and reading a
	// 24-bit file as 16-bit is the kind of mistake that stores noise and calls it a memory.
	it("reads 24-bit PCM and 64-bit float, and refuses an encoding it has no reader for", () => {
		const input = sine(600, 300);
		for (const bits of [24, 64] as const) {
			const decoded = decodeWav(pcmWav(input, { bits }));
			expect(decoded.samples.length).toBe(600);
			for (let i = 0; i < 600; i += 50) expect(decoded.samples[i]!).toBeCloseTo(input[i]!, bits === 24 ? 4 : 5);
		}

		const ccitt = Buffer.from(pcmWav(input, { bits: 16 }));
		ccitt.writeUInt16LE(2, 20); // format tag 2 = CCITT A-law, which this decoder does not claim
		expect(() => decodeWav(new Uint8Array(ccitt))).toThrow(/wav encoding not supported \(format 2, 16-bit\)/);

		// Tag 1 with 32-bit samples is integer PCM, not float — a different scale, and the tag is the only
		// thing that tells them apart.
		const int32 = Buffer.alloc(600 * 4);
		for (let i = 0; i < 600; i += 1) int32.writeInt32LE(Math.round(input[i]! * 2147483648), i * 4);
		const pcm32 = rawWav({ bits: 32, data: int32 });
		const decoded = decodeWav(pcm32);
		for (let i = 0; i < 600; i += 50) expect(decoded.samples[i]!).toBeCloseTo(input[i]!, 5);
	});

	// A file with a format chunk and no data chunk is not a recording.
	it("says a wav has no data chunk, rather than reading silence", () => {
		expect(() => decodeWav(rawWav({ bits: 16, withData: false }))).toThrow(/no data chunk/);
	});

	/** A WAV header written by hand, for the shapes the `pcmWav` helper does not write. */
	function rawWav({ code = 1, bits = 16, data = Buffer.alloc(0), withData = true }: { code?: number; bits?: number; data?: Buffer; withData?: boolean } = {}) {
		const header = Buffer.alloc(44);
		header.write("RIFF", 0);
		header.writeUInt32LE(36 + data.length, 4);
		header.write("WAVE", 8);
		header.write("fmt ", 12);
		header.writeUInt32LE(16, 16);
		header.writeUInt16LE(code, 20);
		header.writeUInt16LE(1, 22);
		header.writeUInt32LE(16_000, 24);
		header.writeUInt32LE((16_000 * bits) / 8, 28);
		header.writeUInt16LE(bits / 8, 32);
		header.writeUInt16LE(bits, 34);
		// Without a data chunk the walk still has to end somewhere: an empty LIST chunk sends it off the end.
		if (withData) {
			header.write("data", 36);
			header.writeUInt32LE(data.length, 40);
		} else {
			header.write("LIST", 36);
			header.writeUInt32LE(0, 40);
		}
		return new Uint8Array(Buffer.concat([header, data]));
	}

	it("says a file is not a wav, or not a whole one, instead of remembering part of it", () => {
		expect(() => decodeWav(new Uint8Array(Buffer.from("OggS not really audio")))).toThrow(/no RIFF\/WAVE header/);
		const truncated = pcmWav(sine(100)).slice(0, 44); // header, no data chunk
		expect(() => decodeWav(truncated)).toThrow(/wav is truncated: 0 of 100 samples/);
	});
});
