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

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ExtensionCtx {
	hasUI?: boolean;
	cwd?: string;
	ui?: { setStatus?: (key: string, text: string) => void; notify?: (message: string, level?: string) => void };
}

interface ExtensionApi {
	on: (event: string, handler: (event: unknown, ctx: ExtensionCtx) => unknown) => void;
	setLabel?: (label: string) => void;
}

const HOME = homedir();
const LIFEOS_DIR = process.env.LIFEOS_DIR ?? join(HOME, ".claude", "LIFEOS");
const OBS_DIR = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY");
const ACTIVITY_FILE = join(OBS_DIR, "tool-activity.jsonl");
const FAILURES_FILE = join(OBS_DIR, "tool-failures.jsonl");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".omp", "agent");
const MODES_MARKER = join(AGENT_DIR, "lifeos-modes.on");

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

	pi.on("session_start", (_event, ctx) => paintStatus(ctx));

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
