/**
 * A pasted file on its way to the agent.
 *
 * The bytes ride along inside the `prompt` command as base64: the browser holds the file and the server
 * holds the disk, and one JSON frame is cheaper than adding an upload endpoint to a protocol that has no
 * HTTP body (docs/protocol.md). What arrives splits in two: images go to pi as image content, because
 * that is what the model looks at; everything else is written to `.flypi/uploads/` and named by its path
 * in the prompt text, so the agent opens it with its own read tools instead of flypi guessing what a
 * PDF or a spreadsheet means.
 */

export interface FlypiAttachment {
	/** The name the user pasted it under — shown in the UI, kept as the file's name on disk. */
	name: string;
	mimeType: string;
	/** The file's bytes, base64. */
	data: string;
}

/** One pasted file's worth of bytes. Clipboard pastes are ad-hoc, so this is a courtesy limit, not a policy. */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;

/** Images belong to the model; every other file belongs to the file tools. */
export function isImage(file: { mimeType: string }): boolean {
	return file.mimeType.startsWith("image/");
}

/**
 * base64 of a file's bytes. Chunked because `String.fromCharCode(...bytes)` on a megabyte overflows the
 * argument list, and a silently truncated attachment is worse than a rejected one.
 */
export function base64Of(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}
