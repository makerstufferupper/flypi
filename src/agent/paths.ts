import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Every path flypi owns lives under `<repo>/.flypi/`. Nothing here may resolve
 * inside the host `~/.pi` (docs/risks.md risk 1). Pass these to pi explicitly —
 * never rely on pi's defaults, which do point at `~/.pi/agent`.
 */
export interface FlypiPaths {
	/** Repo root, i.e. the directory containing `.flypi/`. */
	root: string;
	/** pi's "agent directory": settings.json, models.json, auth.json, mcp.json. */
	agentDir: string;
	/** pi session JSONL files. */
	sessionsDir: string;
	/** SQLite memory store (Phase 3) — the memory component's own database. */
	memoryDir: string;
	/** The memory database file. Named once so no entrypoint can point at a second one by mistake. */
	memoryDbPath: string;
	/** The backend's own database: the run record (Phase 4.5). Never opened by the memory component. */
	runDbPath: string;
	/** Embedding-model cache (Phase 3). */
	modelsDir: string;
	/** Files pasted into the web UI, which the agent then opens by path (docs/protocol.md). */
	uploadsDir: string;
	authPath: string;
	modelsPath: string;
	settingsPath: string;
	mcpPath: string;
	/** Where pi's MCP extension appends server log messages (`logPath`), and where the status panel reads them back. */
	mcpLogPath: string;
	/**
	 * pi's MCP OAuth state (client registration, access/refresh tokens, the pending PKCE verifier), keyed by
	 * server name and URL. Named here because pi's default is `<agent-dir>/mcp-auth.json` of *its* agent dir,
	 * which for flypi would be the host `~/.pi/agent` (risk 1).
	 */
	mcpAuthPath: string;
	/** The vault's key file (docs/secrets.md): mode 0600, created on first use. Never the model keys. */
	secretKeyPath: string;
	/** Where `secret_file` writes a plaintext for a command that only takes a path (ssh, gpg). */
	secretsDir: string;
}

export function flypiPaths(root: string = process.cwd()): FlypiPaths {
	const base = resolve(root);
	const dir = join(base, ".flypi");
	const agentDir = join(dir, "agent");
	return {
		root: base,
		agentDir,
		sessionsDir: join(dir, "sessions"),
		memoryDir: join(dir, "memory"),
		memoryDbPath: join(dir, "memory", "flypi.db"),
		runDbPath: join(dir, "backend", "runs.db"),
		modelsDir: join(dir, "models"),
		uploadsDir: join(dir, "uploads"),
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		settingsPath: join(agentDir, "settings.json"),
		mcpPath: join(agentDir, "mcp.json"),
		mcpLogPath: join(agentDir, "mcp.log"),
		mcpAuthPath: join(agentDir, "mcp-auth.json"),
		secretKeyPath: join(dir, "secret.key"),
		secretsDir: join(dir, "secrets"),
	};
}

/**
 * The invariant as a runtime check rather than a comment: flypi must never read
 * or write the host agent dir. Throws with an actionable message.
 */
export function assertFlypiOwned(paths: FlypiPaths): void {
	const host = resolve(join(homedir(), ".pi"));
	if (paths.root === host || paths.root.startsWith(host + "/")) {
		throw new Error(`flypi config resolves inside the host pi directory ${paths.root} — move .flypi/ outside ~/.pi`);
	}
	if (paths.agentDir !== join(paths.root, ".flypi", "agent")) {
		throw new Error(`agentDir must be .flypi/agent, got ${paths.agentDir}`);
	}
}
