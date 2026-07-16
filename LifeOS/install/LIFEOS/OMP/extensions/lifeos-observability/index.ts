/**
 * lifeos-observability — native OMP port of the LifeOS observability hooks + statusline.
 *
 *   tool_execution_end -> MEMORY/OBSERVABILITY/tool-activity.jsonl   (ToolActivityTracker)
 *   tool_result(isError) -> MEMORY/OBSERVABILITY/tool-failures.jsonl (ToolFailureTracker)
 *   statusline -> ctx.ui.setStatus("lifeos", …) — mode state + session tool count
 *
 * Native (in-process) rather than adapter-bridged because these fire on EVERY tool call —
 * a subprocess per call would add latency the CC hooks never had (they ran async there).
 * Schemas match the CC hooks byte-for-byte so Pulse reads both harnesses' events from the
 * same files. Fail-open: observability must never break a tool call.
 */

import { existsSync, mkdirSync, appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

interface ContextUsage {
	tokens?: number;
	contextWindow?: number;
	percent?: number;
}

interface ExtensionCtx {
	hasUI?: boolean;
	cwd?: string;
	model?: { id?: string; name?: string };
	getContextUsage?: () => Promise<ContextUsage | undefined>;
	ui?: {
		setStatus?: (key: string, text: string) => void;
		notify?: (message: string, level?: string) => void;
		setWidget?: (key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
	};
}

interface ExtensionApi {
	on: (event: string, handler: (event: unknown, ctx: ExtensionCtx) => unknown) => void;
	setLabel?: (label: string) => void;
	registerCommand?: (
		name: string,
		spec: { description: string; handler: (args: string | undefined, ctx: ExtensionCtx) => unknown },
	) => void;
}

const HOME = homedir();
const LIFEOS_DIR = process.env.LIFEOS_DIR ?? join(HOME, ".claude", "LIFEOS");
const OBS_DIR = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY");
const ACTIVITY_FILE = join(OBS_DIR, "tool-activity.jsonl");
const FAILURES_FILE = join(OBS_DIR, "tool-failures.jsonl");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".omp", "agent");
const MODES_MARKER = join(AGENT_DIR, "lifeos-modes.on");
const STATUSLINE_SCRIPT = join(LIFEOS_DIR, "LIFEOS_StatusLine.sh");
// Full statusline panel opt-out marker (panel defaults ON when the script exists).
const STATUSLINE_OFF_MARKER = join(AGENT_DIR, "lifeos-statusline.off");
// setWidget string-array content is capped at 10 lines by OMP's TUI.
const WIDGET_MAX_LINES = 10;
const STATUSLINE_TIMEOUT_MS = 10_000;

const TOOL_NAME_MAP: Record<string, string> = {
	bash: "Bash",
	write: "Write",
	edit: "Edit",
	multiedit: "MultiEdit",
	read: "Read",
	web_search: "WebSearch",
	web_fetch: "WebFetch",
	task: "Agent",
};

function readField(value: unknown, key: string): unknown {
	if (value !== null && typeof value === "object" && key in value) {
		const record: Record<string, unknown> = value;
		return record[key];
	}
	return undefined;
}

function ccToolName(event: unknown): string {
	const raw = readField(event, "toolName") ?? readField(event, "tool_name");
	const name = typeof raw === "string" ? raw : "unknown";
	return TOOL_NAME_MAP[name.toLowerCase()] ?? name;
}

function inputPreview(event: unknown): string {
	const input = readField(event, "input") ?? readField(event, "args");
	if (input === undefined) return "";
	try {
		return JSON.stringify(input).slice(0, 200);
	} catch {
		return "";
	}
}

function appendJsonl(file: string, record: Record<string, unknown>): void {
	try {
		if (!existsSync(OBS_DIR)) mkdirSync(OBS_DIR, { recursive: true });
		appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
	} catch {
		/* observability never breaks a tool call */
	}
}

/**
 * Run the REAL LIFEOS_StatusLine.sh (the same script Claude Code's statusLine
 * setting runs) and return its rendered lines. We synthesize the stdin JSON
 * Claude Code would send — model + context-window fields from OMP's live ctx —
 * and the script computes everything else itself (location/weather caches,
 * TELOS state, memory freshness, mode/effort ladders, usage). Single-sourced:
 * the panel can never drift from the CC statusline because it IS the CC
 * statusline.
 */
function runStatusLine(ctx: ExtensionCtx, usage: ContextUsage | undefined): Promise<string[]> {
	const { promise, resolve } = Promise.withResolvers<string[]>();
	const stdin = JSON.stringify({
		session_id: "omp",
		workspace: { current_dir: ctx.cwd ?? process.cwd() },
		model: { display_name: ctx.model?.name ?? ctx.model?.id ?? "unknown" },
		harness: { name: "OMP", version: process.env.OMP_VERSION ?? "" },
		context_window: {
			context_window_size: usage?.contextWindow ?? 200000,
			used_percentage: usage?.percent ?? 0,
			total_input_tokens: usage?.tokens ?? 0,
		},
	});
	const proc = spawn("bash", [STATUSLINE_SCRIPT], {
		env: { ...process.env, LIFEOS_HARNESS: "omp" },
		stdio: ["pipe", "pipe", "ignore"],
	});
	let out = "";
	const timer = setTimeout(() => {
		proc.kill("SIGTERM");
		resolve([]);
	}, STATUSLINE_TIMEOUT_MS);
	proc.stdout.on("data", (d) => { out += d.toString(); });
	proc.on("close", () => {
		clearTimeout(timer);
		resolve(out.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0));
	});
	proc.on("error", () => {
		clearTimeout(timer);
		resolve([]);
	});
	proc.stdin.write(stdin);
	proc.stdin.end();
	return promise;
}

/**
 * Distill the panel to the widget's 10-line cap: drop pure separator/filler
 * rows (─ ┄ · ═ lines) first — they carry no information in a TUI widget that
 * already has borders — then hard-cap. Content rows keep their ANSI styling.
 */
function distillPanel(lines: string[]): string[] {
	const isSeparator = (l: string): boolean => /^[\s─┄·═┈-]+$/.test(l.replace(/\u001b\[[0-9;]*m/g, ""));
	const content = lines.filter((l) => !isSeparator(l));
	return (content.length > 0 ? content : lines).slice(0, WIDGET_MAX_LINES);
}

export default function lifeosObservability(pi: ExtensionApi): void {
	pi.setLabel?.("LifeOS Observability");

	let toolCount = 0;
	let failCount = 0;

	function paintStatus(ctx: ExtensionCtx): void {
		if (!ctx.hasUI) return;
		const modes = existsSync(MODES_MARKER) ? "modes:ON" : "modes:off";
		const fails = failCount > 0 ? ` ✗${failCount}` : "";
		ctx.ui?.setStatus?.("lifeos", `LifeOS ${modes} · 🔧${toolCount}${fails}`);
	}

	// ── Full statusline panel (the CC statusline, rendered as an OMP widget) ──
	// Default ON when the script exists; `/statusline off` writes the opt-out marker.
	let paintingPanel = false;
	async function paintPanel(ctx: ExtensionCtx): Promise<void> {
		if (!ctx.hasUI || !ctx.ui?.setWidget) return;
		if (!existsSync(STATUSLINE_SCRIPT) || existsSync(STATUSLINE_OFF_MARKER)) {
			ctx.ui.setWidget("lifeos-statusline", undefined);
			return;
		}
		if (paintingPanel) return; // one render in flight; turn_end will re-fire
		paintingPanel = true;
		try {
			const usage = await ctx.getContextUsage?.().catch(() => undefined);
			const lines = await runStatusLine(ctx, usage);
			if (lines.length > 0) ctx.ui.setWidget("lifeos-statusline", distillPanel(lines), { placement: "belowEditor" });
		} catch {
			/* statusline must never break a turn */
		} finally {
			paintingPanel = false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		paintStatus(ctx);
		void paintPanel(ctx);
	});
	pi.on("turn_end", (_event, ctx) => {
		void paintPanel(ctx);
	});

	pi.registerCommand?.("statusline", {
		description: "LifeOS statusline panel: /statusline on|off|refresh",
		handler: (args, ctx) => {
			const want = (typeof args === "string" ? args : "").trim().toLowerCase();
			if (want === "off") {
				writeFileSync(STATUSLINE_OFF_MARKER, `disabled ${new Date().toISOString()}\n`, "utf-8");
				ctx.ui?.setWidget?.("lifeos-statusline", undefined);
				ctx.ui?.notify?.("LifeOS statusline off (marker written)", "info");
				return;
			}
			if (want === "on") {
				if (existsSync(STATUSLINE_OFF_MARKER)) unlinkSync(STATUSLINE_OFF_MARKER);
				ctx.ui?.notify?.("LifeOS statusline on", "info");
			}
			void paintPanel(ctx);
		},
	});

	// ToolActivityTracker parity — one event per completed tool execution.
	pi.on("tool_execution_end", (event, ctx) => {
		toolCount++;
		appendJsonl(ACTIVITY_FILE, {
			timestamp: new Date().toISOString(),
			type: "tool_use",
			session_id: "omp",
			tool_name: ccToolName(readField(event, "data") ?? event),
			tool_input_preview: inputPreview(readField(event, "data") ?? event),
			harness: "omp",
		});
		paintStatus(ctx);
	});

	// ToolFailureTracker parity — errored tool results.
	pi.on("tool_result", (event, ctx) => {
		if (readField(event, "isError") !== true) return undefined;
		failCount++;
		const content = readField(event, "content");
		let error = "unknown error";
		if (Array.isArray(content)) {
			const text = content
				.map((chunk) => (typeof readField(chunk, "text") === "string" ? String(readField(chunk, "text")) : ""))
				.join(" ")
				.trim();
			if (text.length > 0) error = text;
		}
		appendJsonl(FAILURES_FILE, {
			timestamp: new Date().toISOString(),
			event: "tool_failure",
			session_id: "omp",
			tool_name: ccToolName(event),
			error: error.slice(0, 1000),
			tool_input_preview: inputPreview(event),
			harness: "omp",
		});
		paintStatus(ctx);
		return undefined;
	});
}
