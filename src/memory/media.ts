/**
 * The media a memory can carry — an image or a recording — plus decoding far enough for the
 * embedding model to see it.
 *
 * The bytes are the memory; the path is where it came from. Both are kept: a file can be deleted or
 * moved, and a media row that lost its file still has its bytes and its vector (docs/memory.md,
 * multimodal memory).
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export type MediaKind = "image" | "audio";

export interface MemoryMedia {
	kind: MediaKind;
	/** Provenance, and what the image decoder reads. */
	path: string;
	mime: string;
	bytes: Uint8Array;
}

/** What EG2's audio encoder is fed: mono, 16 kHz, samples in [-1, 1]. */
export const AUDIO_RATE = 16_000;

const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};
const AUDIO_MIME: Record<string, string> = { ".wav": "audio/wav" };

/**
 * Read a media file and say what it is. Only WAV is accepted for audio: mp3/m4a would need a decoder
 * of our own or an ffmpeg subprocess, and every recorder on this machine can write WAV.
 *
 * shortcut: container == extension, when a caller needs mime sniffing, read the file's magic bytes.
 */
export async function readMedia(path: string): Promise<MemoryMedia> {
	const extension = extname(path).toLowerCase();
	const mime = IMAGE_MIME[extension] ?? AUDIO_MIME[extension];
	if (!mime) {
		throw new Error(`unsupported media ${extension || path}: images are png/jpeg/webp/gif, audio is wav (re-encode the recording to wav)`);
	}
	const bytes = new Uint8Array(await readFile(path));
	if (bytes.length === 0) throw new Error(`${path} is empty`);
	return { kind: extension in AUDIO_MIME ? "audio" : "image", path, mime, bytes };
}

export interface DecodedAudio {
	samples: Float32Array;
	seconds: number;
}

/**
 * Decode a WAV into mono 16 kHz floats: PCM 8/16/24/32 and IEEE float, any channel count downmixed,
 * any rate resampled. The container's own metadata is trusted, and a file that does not parse says
 * so — a half-decoded voice note would be indexed as a different one.
 */
export function decodeWav(bytes: Uint8Array): DecodedAudio {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
	if (bytes.length < 44 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") {
		throw new Error("not a wav file (no RIFF/WAVE header)");
	}

	let format: { code: number; channels: number; rate: number; bits: number } | undefined;
	let at = 12;
	while (at + 8 <= bytes.length) {
		const id = ascii(at);
		const size = view.getUint32(at + 4, true);
		const body = at + 8;
		if (id === "fmt ") {
			format = {
				code: view.getUint16(body, true),
				channels: view.getUint16(body + 2, true),
				rate: view.getUint32(body + 4, true),
				bits: view.getUint16(body + 14, true),
			};
		} else if (id === "data" && format) {
			const perSample = format.bits / 8;
			const width = perSample * format.channels; // bytes per frame, all channels
			const declared = Math.floor(size / width);
			const frames = Math.floor((bytes.length - body) / width);
			// A recording cut off mid-write is a different memory than the whole one, so it is refused
			// rather than remembered short.
			if (frames < declared) throw new Error(`wav is truncated: ${frames} of ${declared} samples are there`);
			const mono = new Float32Array(frames);
			for (let frame = 0; frame < frames; frame += 1) {
				let sum = 0;
				for (let channel = 0; channel < format.channels; channel += 1) {
					const offset = body + frame * width + channel * perSample;
					sum += sampleAt(view, offset, format);
				}
				mono[frame] = sum / format.channels;
			}
			return { samples: resample(mono, format.rate, AUDIO_RATE), seconds: mono.length / format.rate };
		}
		at += 8 + size + (size % 2);
	}
	throw new Error("wav file has no data chunk");
}

function sampleAt(view: DataView, offset: number, format: { code: number; bits: number }): number {
	const { code, bits } = format;
	if (code === 3) {
		if (bits === 32) return view.getFloat32(offset, true);
		if (bits === 64) return view.getFloat64(offset, true);
	}
	if (code === 1) {
		if (bits === 8) return (view.getUint8(offset) - 128) / 128; // 8-bit PCM is unsigned
		if (bits === 16) return view.getInt16(offset, true) / 32768;
		if (bits === 24) {
			const packed = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
			return (packed << 8) / 2147483648; // << 8 sign-extends a 24-bit sample
		}
		if (bits === 32) return view.getInt32(offset, true) / 2147483648;
	}
	throw new Error(`wav encoding not supported (format ${code}, ${bits}-bit)`);
}

/** Linear interpolation: good enough for a 16 kHz mel spectrogram, and it keeps this dependency-free. */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
	if (from === to || samples.length === 0) return samples;
	const ratio = to / from;
	const out = new Float32Array(Math.max(0, Math.round(samples.length * ratio)));
	for (let i = 0; i < out.length; i += 1) {
		const at = i / ratio;
		const low = Math.floor(at);
		const high = Math.min(low + 1, samples.length - 1);
		out[i] = samples[low]! + (samples[high]! - samples[low]!) * (at - low);
	}
	return out;
}
