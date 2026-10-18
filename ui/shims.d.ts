/// <reference types="vite/client" />
/**
 * `tsc` cannot see inside a `.svelte` file, so the import itself gets a loose type here.
 * ponytail: component props are therefore unchecked by `npm run typecheck`; add `svelte-check`
 * as the component-level typechecker if the component set ever outgrows these four.
 */
declare module "*.svelte" {
	import type { ComponentType } from "svelte";
	const component: ComponentType<Record<string, unknown>>;
	export default component;
}
