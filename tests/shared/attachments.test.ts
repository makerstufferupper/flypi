import { describe, expect, it } from "vitest";
import { base64Of, isImage } from "../../src/shared/attachments.ts";

describe("base64Of", () => {
	it("encodes the same bytes as Buffer, at every length including the chunk boundary", () => {
		// The chunking is the bug this test exists for: an argument-list overflow or an off-by-one in a
		// slice truncates an attachment instead of failing, and a truncated PNG is a silent wrong answer.
		for (const size of [0, 1, 2, 3, 4, 255, 4096, 0x8000, 0x8001, 0x10002]) {
			const bytes = new Uint8Array(size);
			for (let i = 0; i < size; i += 1) bytes[i] = (i * 37 + 11) % 256;
			const roundTrip = Buffer.from(base64Of(bytes.buffer), "base64");
			expect(roundTrip.equals(bytes), `size ${size}`).toBe(true);
		}
	});

	it("keeps high bytes intact (base64 input is bytes, not characters)", () => {
		expect(base64Of(new Uint8Array([0, 127, 128, 255]).buffer)).toBe("AH+A/w==");
	});
});

describe("isImage", () => {
	it("splits what belongs to the model from what belongs to the file tools", () => {
		expect(isImage({ mimeType: "image/png" })).toBe(true);
		expect(isImage({ mimeType: "application/pdf" })).toBe(false);
		expect(isImage({ mimeType: "" })).toBe(false);
	});
});
