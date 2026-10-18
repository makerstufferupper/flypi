/**
 * Measure a contradiction judge before deciding to run one (docs/memory.md Phase 4, "The judge for
 * paraphrase"). Three questions, in the order they would be asked: what it costs to load and hold
 * (especially next to a resident EG2), how long a ≤5-pair batch takes on the write path, and what it
 * actually decides on a small labelled pair set — against the token rule that already ships.
 *
 * Run: `npx tsx scripts/benchmark-nli.ts [--model <id>] [--dtype q8|fp32] [--no-eg2]`
 *
 * This is a measurement, not a feature: nothing here is imported by src/**, and no verdict in the
 * store changes because of it. The pairs are the seed of the corpus the plan asks for; they are
 * written by hand, so they show what the rule and the model do, not what they score in production.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import { flypiPaths } from "../src/agent/paths.ts";
import { cosine, createEmbedder, type Embedder } from "../src/memory/embed.ts";
import { EMBED_MODEL, JUDGE_MODEL } from "../src/memory/config.ts";
import { CONTRADICTION_SIMILARITY, chooseVerdict, verdictFor } from "../src/memory/judge.ts";
import { differentKey, valueSwap } from "../src/memory/store.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const absent = (name: string) => !args.includes(`--${name}`);
const MODEL = flag("model", JUDGE_MODEL);
const DTYPE = flag("dtype", "q8") as "q8" | "fp32";
const MAX_LENGTH = Number(flag("max-length", "256"));
/** Where a model may retire a fact. Shipped as `CONTRADICTION_SIMILARITY`; overridable here because the
 * right value is a property of the corpus, not of the model, and the corpus is meant to grow. */
const FLOOR = Number(flag("floor", String(CONTRADICTION_SIMILARITY)));
const cacheDir = flypiPaths(process.cwd()).modelsDir;

/** What the store would do with this pair, in the order it does it. */
type Decision = "contradict" | "duplicate" | "extend" | "new";
interface Pair {
	stored: string;
	incoming: string;
	expect: Decision;
	why: string;
}

/**
 * Hand-written, one per class the write gate has to tell apart. The `…value` rows are the class the
 * token rule already decides; the `…paraphrase` rows are why a model is being considered at all — the
 * rule declines every one of them (asserted in tests/memory/store.test.ts).
 */
const PAIRS: Pair[] = [
	{ stored: "the deploy port is 8080", incoming: "the deploy port is 9090", expect: "contradict", why: "port value" },
	{ stored: "the api url is https://api.internal/v1", incoming: "the api url is https://api.internal/v2", expect: "contradict", why: "version value" },
	{ stored: "the vault key lives in .flypi/secret.key", incoming: "the vault key lives in ~/.config/flypi/key", expect: "contradict", why: "path value" },
	{ stored: "the nightly build runs at 02:00 UTC", incoming: "the nightly build runs at 04:00 UTC", expect: "contradict", why: "time value" },
	{ stored: "the retention window is 30 days", incoming: "the retention window is 90 days", expect: "contradict", why: "number value" },
	{ stored: "the ci runner is ubuntu-latest", incoming: "the ci runner is macos-latest", expect: "contradict", why: "name value" },
	{ stored: "we use pnpm, never npm", incoming: "we do not use pnpm", expect: "contradict", why: "polarity flip" },
	{ stored: "prefer bun over pnpm in this repo", incoming: "we use pnpm, never npm", expect: "contradict", why: "paraphrase" },
	{ stored: "we use pnpm, never npm", incoming: "pnpm is not allowed in this repo", expect: "contradict", why: "paraphrase" },
	{ stored: "the deploy port is 8080", incoming: "the service listens on port 9090", expect: "contradict", why: "paraphrase" },
	{ stored: "the vault key lives in .flypi/secret.key", incoming: "the vault key path moved to the config dir", expect: "contradict", why: "paraphrase" },
	{ stored: "the deploy host is 10.0.0.5", incoming: "the deploy host is the bastion, not an ip", expect: "contradict", why: "paraphrase" },
	{ stored: "we use pnpm, never npm", incoming: "the project uses pnpm and not npm", expect: "duplicate", why: "reworded copy" },
	{ stored: "the deploy target is the small box", incoming: "deployments go to the small box", expect: "duplicate", why: "reworded copy" },
	{ stored: "the staging database is postgres 15", incoming: "staging runs postgres version 15", expect: "duplicate", why: "reworded copy" },
	{ stored: "the deploy target is the small box", incoming: "the deploy target is the small box running ubuntu 24.04", expect: "extend", why: "adds detail" },
	{ stored: "we use pnpm, never npm", incoming: "we use pnpm, never npm; commit the lockfile", expect: "extend", why: "adds detail" },
	{ stored: "the build runs npm test", incoming: "the build runs npm test, then lint, on ubuntu-latest", expect: "extend", why: "adds detail" },
	{ stored: "the deploy port is 8080", incoming: "the deploy host is 10.0.0.5", expect: "new", why: "different key" },
	{ stored: "the deploy port is 8080", incoming: "the wiki lives at wiki/ops", expect: "new", why: "unrelated" },
	{ stored: "the api base url is https://api.internal/v1", incoming: "the grafana dashboard is at grafana/internal/api", expect: "new", why: "shares words, not facts" },
];

const onnxFiles = (dir: string) => {
	const out: { file: string; bytes: number }[] = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const path = join(d, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".onnx")) out.push({ file: entry.name, bytes: statSync(path).size });
		}
	};
	try {
		walk(dir);
	} catch {
		/* not downloaded */
	}
	return out.sort((a, b) => b.bytes - a.bytes);
};

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const rss = () => process.memoryUsage().rss;
const log = console.log;
/** A refused embedding prints as — in the table rather than pretending to be a number. */
const vectorOf = async (embedder: Embedder, text: string) => {
	const result = await embedder.embedDocument(text);
	return result.ok ? result.vector : null;
};

async function main() {
	const baseline = rss();
	const modelDir = join(cacheDir, ...MODEL.split("/"));
	const before = onnxFiles(modelDir);
	const t0 = Date.now();
	const tokenizer = await AutoTokenizer.from_pretrained(MODEL, { cache_dir: cacheDir });
	const model = await AutoModelForSequenceClassification.from_pretrained(MODEL, { cache_dir: cacheDir, dtype: DTYPE });
	const loadMs = Date.now() - t0;
	const after = onnxFiles(modelDir);
	const downloaded = after.filter((f) => !before.some((b) => b.file === f.file)).reduce((sum, f) => sum + f.bytes, 0);
	const labels: Record<string, string> = ((model.config ?? {}) as unknown as { id2label?: Record<string, string> }).id2label ?? {};

	log(`model   ${MODEL} (dtype ${DTYPE}, max_length ${MAX_LENGTH})`);
	log(`rss     ${(baseline / 1e6).toFixed(0)} MB before any weights (runtime + ort only)`);
	log(`load    ${loadMs} ms  (tokenizer + weights);  rss after load ${(rss() / 1e6).toFixed(0)} MB`);
	log(`weights ${downloaded ? `downloaded ${mb(downloaded)} now` : "already in the cache"}; on disk ${mb(after.reduce((s, f) => s + f.bytes, 0))} in ${after.length} onnx files`);
	log(`labels  ${JSON.stringify(labels)}`);
	if (!Object.keys(labels).length) {
		log("FAILED the model carries no id2label — a verdict would be a guess about index order. Stop.");
		return;
	}

	/** Model labels are not spelled consistently across checkpoints; map on the word, not the index. */
	const classOf = (label: string) => {
		const text = label.toLowerCase();
		if (text.includes("contra")) return "contradiction";
		if (text.includes(" entail")) return "entailment";
		if (text.includes("neutral")) return "neutral";
		return label;
	};
	const judge = async (pairs: [string, string][]) => {
		// A cross-encoder reads (premise, hypothesis): the stored row is what we are checking the new
		// sentence against. v4 takes the second sequence as an option, and `padding` lines the batch up.
		const inputs = await tokenizer(pairs.map(([premise]) => premise), {
			text_pair: pairs.map(([, hypothesis]) => hypothesis),
			padding: true,
			truncation: true,
			max_length: MAX_LENGTH,
			return_token_type_ids: true,
		});
		const output = await model(inputs);
		const rows = (output.logits.tolist() as number[][]).map((logits) => {
			const max = Math.max(...logits);
			const weights = logits.map((value) => Math.exp(value - max));
			const total = weights.reduce((sum, value) => sum + value, 0);
			return weights.map((value) => value / total);
		});
		// The EG2 lesson: a wrong dtype can return NaN and still look like an answer.
		if (rows.some((probs) => probs.some((value) => !Number.isFinite(value)))) log("WARN non-finite logits — this dtype is unusable");
		return rows.map((probs) => {
			const index = probs.indexOf(Math.max(...probs));
			return { nli: classOf(labels[String(index)] ?? String(index)), confidence: probs[index] ?? 0, probs };
		});
	};

	// Latency the way the write path would pay it: one pair, then a full batch of five candidates.
	const one = await judge([[PAIRS[0]!.stored, PAIRS[0]!.incoming]]);
	const singleMs = Date.now() - t0;
	const tBatch = Date.now();
	const batch = await judge(PAIRS.slice(0, 5).map((pair) => [pair.stored, pair.incoming] as [string, string]));
	const batchMs = Date.now() - tBatch;
	log(`latency one pair ~${Math.round((singleMs - loadMs) / one.length)} ms; five pairs in one pass ${batchMs} ms (${batch.length} rows) — the first call includes warm-up`);

	// The whole point of the plan's risk 3: this would live next to a resident EG2, not alone.
	let embed: Awaited<ReturnType<typeof createEmbedder>> | null = null;
	if (absent("no-eg2")) {
		const beforeEg2 = rss();
		embed = await createEmbedder({ provider: "transformers", model: EMBED_MODEL, quantized: true, cacheDir });
		log(`rss with EG2 loading on top: ${(beforeEg2 / 1e6).toFixed(0)} MB → ${(rss() / 1e6).toFixed(0)} MB (${embed.identity ? "loaded" : `refused: ${embed.error}`})`);
	}

	const scores: Record<Decision, { right: number; wrong: number }> = { contradict: { right: 0, wrong: 0 }, duplicate: { right: 0, wrong: 0 }, extend: { right: 0, wrong: 0 }, new: { right: 0, wrong: 0 } };
	log(`\nexpected → what the store would do (rule first, then the model)  [C=conf]\n`);
	const measured: { pair: Pair; cos: number | null; swap: boolean; key: boolean; was: number; now: number; nli: string; conf: number }[] = [];
	for (const pair of PAIRS) {
		const verdict = (await judge([[pair.stored, pair.incoming]]))[0]!;
		const swap = valueSwap(pair.incoming, pair.stored);
		const [storedVector, incomingVector] = embed?.identity
			? await Promise.all([vectorOf(embed, pair.stored), vectorOf(embed, pair.incoming)])
			: [null, null];
		const similarity = storedVector && incomingVector ? cosine(storedVector, incomingVector) : null;
		measured.push({ pair, cos: similarity, swap: swap !== undefined, key: differentKey(pair.incoming, pair.stored), was: swap?.was.length ?? 0, now: swap?.now.length ?? 0, nli: verdict.nli, conf: verdict.confidence });
		const decided: Decision = swap
			? "contradict"
			: verdict.nli === "contradiction"
				? "contradict"
				: verdict.nli === "entailment"
					? (similarity ?? 0) >= 0.95
						? "duplicate"
						: "extend"
					: (similarity ?? 0) >= 0.95
						? "extend"
						: "new";
		const ok = decided === pair.expect;
		scores[pair.expect][ok ? "right" : "wrong"] += 1;
		log(
			`${ok ? "ok  " : "MISS"} ${pair.why.padEnd(24)} cos ${similarity === null ? "  —  " : similarity.toFixed(4)}  rule ${swap ? `${swap.was.length}/${swap.now.length} tokens` : "none       "}  nli ${verdict.nli.padEnd(13)} [${verdict.confidence.toFixed(2)}]  → ${decided.padEnd(10)} expected ${pair.expect}`,
		);
	}

	log("\nby class:");
	for (const [decision, score] of Object.entries(scores)) log(`  ${decision.padEnd(11)} ${score.right} right, ${score.wrong} wrong`);

	/**
	 * The number that decides anything is not accuracy: it is how many true facts get retired that should
	 * not be (a silent rewrite of history) against how many corrections get missed (recoverable — the old
	 * row stays active and recall de-dupes at read time). `extend` and `new` are the same action, so they
	 * are scored as one: keep both rows.
	 */
	const actionOf = (row: (typeof measured)[number], policy: (row: (typeof measured)[number]) => Decision): "supersede" | "refuse" | "keep" => {
		const decided = policy(row);
		return decided === "contradict" ? "supersede" : decided === "duplicate" ? "refuse" : "keep";
	};
	const wanted = (pair: Pair) => (pair.expect === "contradict" ? "supersede" : pair.expect === "duplicate" ? "refuse" : "keep");
	/** One answer for one pair, exactly as the store would order it, at a given floor. */
	function shippedPolicy(floor: number): (row: (typeof measured)[number]) => Decision {
		return (row) => {
			if ((row.cos ?? 0) >= 0.95 && !row.swap) return "duplicate"; // the write gate, no model asked
			const label = row.nli as "contradiction" | "entailment" | "neutral";
			const verdict = chooseVerdict([{ id: 1, verdict: verdictFor(label, row.conf, row.cos ?? 0, floor) }]).verdict;
			if (verdict === "duplicate") return "duplicate";
			if (verdict === "extend") return "new"; // the model read it as the same fact in more words
			if (verdict === "contradict" && !row.key) return "contradict"; // the frame test vetoes a different-key pair
			return row.swap ? "contradict" : "new";
		};
	}

	const policies: Record<string, (row: (typeof measured)[number]) => Decision> = {
		/** What `src/memory/judge.ts` + `addMemory` do now, in code rather than by hand. */
		"shipped policy": shippedPolicy(FLOOR),
		"no judge configured": (row) => (row.swap ? "contradict" : (row.cos ?? 0) >= 0.95 ? "duplicate" : "new"),
		/** The same policy with the deterministic frame veto removed, so a re-run shows what that guard buys. */
		"the judge without the frame veto": (row) => {
			if ((row.cos ?? 0) >= 0.95 && !row.swap) return "duplicate";
			const label = row.nli as "contradiction" | "entailment" | "neutral";
			const verdict = chooseVerdict([{ id: 1, verdict: verdictFor(label, row.conf, row.cos ?? 0, FLOOR) }]).verdict;
			if (verdict === "duplicate" || verdict === "contradict") return verdict;
			return row.swap && verdict !== "extend" ? "contradict" : "new";
		},
	};
	log(`\npolicy comparison over the same pairs, similarity floor ${FLOOR.toFixed(2)} (false supersede = a true fact retired for no reason):\n`);
	const tally = (policy: (row: (typeof measured)[number]) => Decision) => {
		const wrong = { superseded: 0, missed: 0, refused: 0, missedCopy: 0 };
		const misses: string[] = [];
		for (const row of measured) {
			const got = actionOf(row, policy);
			const want = wanted(row.pair);
			if (got === want) continue;
			if (got === "supersede") wrong.superseded += 1; // retired something that should have stayed (a copy or a different fact)
			if (want === "supersede") wrong.missed += 1;
			if (want === "refuse" && got === "keep") wrong.missedCopy += 1;
			if (got === "supersede" || want === "supersede") misses.push(`      ${row.pair.why} (cos ${row.cos === null ? "—" : row.cos.toFixed(4)}, ${row.nli} ${row.conf.toFixed(2)})`);
		}
		return { ...wrong, misses };
	};
	for (const [name, policy] of Object.entries(policies)) {
		const wrong = tally(policy);
		log(`  ${name}`);
		log(`    ${wrong.superseded} false supersede, ${wrong.missed} missed correction, ${wrong.missedCopy} copy written as a new row`);
		if (wrong.misses.length) log(wrong.misses.join("\n"));
	}
	// The floor is the open question, so it is measured rather than argued: `--sweep` re-runs the shipped
	// policy at each value over the same pairs, with no model asked twice.
	if (args.includes("--sweep")) {
		log("\nthe shipped policy, floor by floor:");
		for (const floor of (flag("sweep", "0.95,0.9,0.85,0.8,0.7")).split(",").map(Number)) {
			const wrong = tally(shippedPolicy(floor));
			log(`  floor ${floor.toFixed(2)}: ${wrong.superseded} false supersede, ${wrong.missed} missed correction, ${wrong.missedCopy} copy written as a new row`);
		}
	}
	log(`\npeak rss ${(rss() / 1e6).toFixed(0)} MB`);
}

await main();
