/**
 * The one command that answers "does end-to-end agent execution still work?" — docs/testing.md.
 *
 * It is a driver, not a test: the assertions live in the test files. What this adds is the two
 * things a suite cannot show you, the recorded fixture rendered by the same mapper the UI uses
 * (`tests/fixtures/transcript-log`, "if they disagree, one of them is wrong") and a real
 * end-to-end turn through the server printed as the transcript a user would see.
 *
 * Run: npm run smoke
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { startFlypiServer } from "../src/server/index.ts";
import { reduceEvents, renderTranscriptText } from "../src/shared/transcript.ts";
import { harness, toolTurn } from "../tests/helpers/flypi-harness.ts";

const fixtureDir = resolve(import.meta.dirname, "../tests/fixtures/transcript-log");
const events = JSON.parse(readFileSync(resolve(fixtureDir, "events.json"), "utf8"));
const golden = readFileSync(resolve(fixtureDir, "transcript.txt"), "utf8");

const rendered = renderTranscriptText(reduceEvents(events));
// Byte for byte, the same comparison tests/shared/transcript.test.ts makes.
if (rendered !== golden) {
	console.error("FAIL: the shared mapper no longer renders the recorded fixture like the tests do.");
	console.error(`rendered ${rendered.trimEnd().split("\n").length} lines, golden ${golden.trimEnd().split("\n").length} lines`);
	process.exit(1);
}
console.log(`ok: fixture — ${events.length} events rendered as ${rendered.trimEnd().split("\n").length} lines`);

// An end-to-end turn: scripted stub model → session → registry → WS server → shared mapper.
const h = await harness(toolTurn());
const server = await startFlypiServer({ registry: h.registry });
const socket = new WebSocket(`${server.url}/?token=${encodeURIComponent(server.token)}`);
const send = (command) => socket.send(JSON.stringify(command));

await new Promise((opened) => socket.once("open", opened));
const settled = new Promise((done, failed) => {
	socket.on("message", (raw) => {
		const frame = JSON.parse(String(raw));
		if (frame.type === "error") return failed(new Error(`server said: ${frame.message}`));
		if (frame.type === "result" && frame.requestId === "1") {
			send({ type: "prompt", conversationId: frame.conversationId, text: "list the files" });
			return;
		}
		if (frame.type === "event" && frame.event.type === "agent_settled") done(frame.conversationId);
	});
});
send({ type: "newSession", requestId: "1" });
const conversationId = await settled;

const eventsOfTurn = h.registry.get(conversationId).session.messages;
const answer = JSON.stringify(eventsOfTurn);
console.log(`ok: end-to-end — ${eventsOfTurn.length} messages, the model's answer reached the session: ${/listed the files/.test(answer)}`);
console.log(renderTranscriptText(reduceEvents(eventsOfTurn.map((message) => ({ type: "message_end", message })))).split("\n").slice(0, 6).join("\n"));
socket.close();
await server.close();
h.cleanup();
process.exit(/listed the files/.test(answer) ? 0 : 1);
