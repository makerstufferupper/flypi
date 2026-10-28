/**
 * The UI's whole startup: read the config the server exposes, open one socket, mount one component.
 * Everything else the page knows arrives over that socket (docs/protocol.md).
 */
import { mount } from "svelte";
import App from "./App.svelte";
import { fetchConfig, Socket } from "./lib/client.ts";
import { initTheme } from "./lib/theme.ts";
import { trackAppHeight } from "./lib/viewport.ts";
import "./app.css";

const target = document.getElementById("app");
if (!target) throw new Error("flypi: #app is missing from index.html");

initTheme();
// The keyboard is the one size the CSS cannot read (ui/lib/viewport.ts); it is published before the first
// mount so the page never lays out on the wrong height.
trackAppHeight();
const config = await fetchConfig();
if (config.protocolVersion !== 1) {
	target.textContent = `flypi UI speaks protocol v1, the server speaks v${config.protocolVersion}`;
} else {
	const socket = new Socket(config);
	mount(App, { target, props: { transport: socket } });
	socket.connect();
}
