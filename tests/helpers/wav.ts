/** A tiny WAV writer, so the audio tests carry their own input instead of a committed fixture. */
export interface WavOptions {
	rate?: number;
	channels?: number;
	bits?: 8 | 16 | 24 | 32 | 64;
}

/** `frames` is mono; stereo duplicates it, which is enough to check a downmix. */
export function pcmWav(frames: Float32Array, { rate = 16_000, channels = 1, bits = 16 }: WavOptions = {}): Uint8Array {
	const perSample = bits / 8;
	const data = Buffer.alloc(frames.length * channels * perSample);
	for (let frame = 0; frame < frames.length; frame += 1) {
		for (let channel = 0; channel < channels; channel += 1) {
			const value = frames[frame]!;
			const offset = (frame * channels + channel) * perSample;
			if (bits === 32) data.writeFloatLE(value, offset);
			else if (bits === 64) data.writeDoubleLE(value, offset);
			else if (bits === 24) data.writeIntLE(Math.max(-8388608, Math.min(8388607, Math.round(value * 8388608))), offset, 3);
			else if (bits === 16) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32768))), offset);
			else data.writeUInt8(Math.max(0, Math.min(255, Math.round(value * 128 + 128))), offset);
		}
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(bits === 32 || bits === 64 ? 3 : 1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * channels * perSample, 28);
	header.writeUInt16LE(channels * perSample, 32);
	header.writeUInt16LE(bits, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	return new Uint8Array(Buffer.concat([header, data]));
}

/** A rising sine, so a decoded value can be compared against a known one. */
export function sine(frames: number, hertz = 440, rate = 16_000): Float32Array {
	const samples = new Float32Array(frames);
	for (let i = 0; i < frames; i += 1) samples[i] = 0.5 * Math.sin((2 * Math.PI * hertz * i) / rate);
	return samples;
}
