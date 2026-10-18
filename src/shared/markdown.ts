/**
 * Markdown for the chat (docs/architecture.md Phase 2: "Chat rendering: markdown (marked)").
 *
 * `marked` is the one exception to flypi's no-framework rule, and it is a rendering exception only —
 * it renders model output, it is not the app's HTML. Tests assert the structure it produces
 * (docs/testing.md), so swapping the renderer is a test diff, not a rewrite.
 */
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(text: string): string {
	// The agent and its tool outputs may contain HTML; escaping `<` keeps a tool result from
	// injecting live markup into the page, and `javascript:`/`data:` hrefs are the other half of it.
	const html = marked.parse(text.replace(/</g, "&lt;"), { async: false });
	return html.replace(/href=["']\s*(?:javascript|data|vbscript):/gi, 'href="#blocked:');
}
