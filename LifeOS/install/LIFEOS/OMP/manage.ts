#!/usr/bin/env bun
/**
 * manage.ts — install / uninstall / status / inference for the LifeOS↔OMP integration.
 *
 *   bun manage.ts install     wire the extensions into ~/.omp/agent/config.yml
 *                             and symlink APPEND_SYSTEM.md (idempotent)
 *   bun manage.ts uninstall   remove those wirings (leaves the OMP tree + tool patches)
 *   bun manage.ts status      report what is / isn't wired
 *
 * The extension SOURCE + adapted constitutions live in this directory (LIFEOS/OMP/),
 * version-controlled with LifeOS. This script only touches the machine-specific
 * wiring under the OMP agent dir, so it is safe to re-run on a fresh machine.
 * config.yml is parsed/merged as YAML (never blind-appended) and backed up first.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { parse, stringify } from "yaml";

const HOME = homedir();
const SELF_DIR = import.meta.dir; // …/.claude/LIFEOS/OMP
const LIFEOS_DIR = dirname(SELF_DIR); // …/.claude/LIFEOS
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".omp", "agent");
const CONFIG_PATH = join(AGENT_DIR, "config.yml");
const APPEND_LINK = join(AGENT_DIR, "APPEND_SYSTEM.md");
const APPEND_SRC = join(SELF_DIR, "APPEND_SYSTEM.md");
const APPEND_BAK = `${APPEND_LINK}.pre-lifeos.bak`;
// Legacy (pre-7.x mode system) marker — cleared if found; nothing writes it anymore.
const LEGACY_MODES_MARKER = join(AGENT_DIR, "lifeos-modes.on");
const INFERENCE_BACKEND_FILE = join(HOME, ".claude", "LIFEOS", "USER", "CONFIG", "inference-backend");

const EXTENSION_NAMES = ["lifeos-memory", "lifeos-commands", "lifeos-safety", "lifeos-hooks", "lifeos-observability"];

// Emit a home-relative (~/…) path when possible so config stays portable.
function tildify(abs: string): string {
	return abs.startsWith(`${HOME}/`) ? `~${abs.slice(HOME.length)}` : abs;
}

const EXTENSION_PATHS = EXTENSION_NAMES.map((name) => tildify(join(SELF_DIR, "extensions", name)));

function readConfig(): Record<string, unknown> {
	if (!existsSync(CONFIG_PATH)) return {};
	const parsed: unknown = parse(readFileSync(CONFIG_PATH, "utf8"));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	// Runtime-verified object shape; treat as a string-keyed config map.
	return parsed as Record<string, unknown>;
}

function writeConfig(config: Record<string, unknown>): void {
	if (existsSync(CONFIG_PATH)) copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.lifeos-bak`);
	writeFileSync(CONFIG_PATH, stringify(config), "utf8");
}

function currentExtensions(config: Record<string, unknown>): string[] {
	const raw = config.extensions;
	return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
}

function isOurLink(): boolean {
	try {
		const st = lstatSync(APPEND_LINK);
		if (!st.isSymbolicLink()) return false;
		return readlinkSync(APPEND_LINK) === APPEND_SRC;
	} catch {
		return false;
	}
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function verifySource(): string[] {
	const problems: string[] = [];
	if (!existsSync(APPEND_SRC)) problems.push(`missing constitution: ${APPEND_SRC}`);
	for (const name of EXTENSION_NAMES) {
		if (!existsSync(join(SELF_DIR, "extensions", name, "index.ts"))) problems.push(`missing extension: ${name}/index.ts`);
	}
	const reviewer = join(LIFEOS_DIR, "TOOLS", "MemoryReviewer.ts");
	if (existsSync(reviewer) && !readFileSync(reviewer, "utf8").includes("OMP_SESSIONS_DIR")) {
		problems.push("MemoryReviewer.ts lacks the OMP session-store patch (autonomic loop will read CC transcripts only)");
	}
	const parser = join(LIFEOS_DIR, "TOOLS", "TranscriptParser.ts");
	// UAI's parser handles OMP via the nested { message: { role, content } } branch in
	// textMessageFromEntry/isRealUserPrompt (upstream LifeOS uses normalizeEntry instead).
	if (existsSync(parser) && !/message\?\.role|normalizeEntry/.test(readFileSync(parser, "utf8"))) {
		problems.push("TranscriptParser.ts lacks the OMP-format patch (Stop hooks will no-op on OMP transcripts)");
	}
	return problems;
}

function install(): void {
	const problems = verifySource();
	if (problems.length > 0) {
		console.error("✗ Source not ready — the LifeOS/OMP tree is incomplete on this machine:");
		for (const p of problems) console.error(`  - ${p}`);
		process.exit(1);
	}

	// 1) Symlink the constitution (back up any pre-existing non-symlink file). Modes-aware:
	// if either variant is already linked, leave it — reinstall must not flip the toggle.
	if (isOurLink()) {
		console.log("• APPEND_SYSTEM.md already linked");
	} else {
		if (pathExists(APPEND_LINK)) renameSync(APPEND_LINK, APPEND_BAK);
		symlinkSync(APPEND_SRC, APPEND_LINK);
		console.log(`• linked APPEND_SYSTEM.md -> ${tildify(APPEND_SRC)}`);
	}

	// 2) Merge the extensions into config.extensions (dedup, preserve everything else).
	const config = readConfig();
	const existing = currentExtensions(config);
	const merged = [...existing];
	let added = 0;
	for (const path of EXTENSION_PATHS) {
		if (!merged.includes(path)) {
			merged.push(path);
			added++;
		}
	}
	config.extensions = merged;
	writeConfig(config);
	console.log(`• config.yml extensions: ${added} added, ${merged.length} total`);
	console.log(`\n✓ Installed. Open a fresh 'omp' session to activate. Verify: bun ${tildify(join(SELF_DIR, "manage.ts"))} status`);
}

function uninstall(): void {
	// 1) Remove our extensions from config; drop the key if it becomes empty.
	if (existsSync(CONFIG_PATH)) {
		const config = readConfig();
		const kept = currentExtensions(config).filter((path) => !EXTENSION_PATHS.includes(path));
		if (kept.length > 0) config.extensions = kept;
		else delete config.extensions;
		writeConfig(config);
		console.log(`• config.yml extensions: LifeOS entries removed (${kept.length} non-LifeOS kept)`);
	}

	// 2) Remove our symlink; restore any backed-up original.
	if (isOurLink()) {
		unlinkSync(APPEND_LINK);
		if (pathExists(APPEND_BAK)) {
			renameSync(APPEND_BAK, APPEND_LINK);
			console.log("• restored pre-LifeOS APPEND_SYSTEM.md from backup");
		} else {
			console.log("• removed APPEND_SYSTEM.md symlink");
		}
	} else {
		console.log("• APPEND_SYSTEM.md not our symlink — left untouched");
	}

	// 3) Clear the legacy mode-system marker if a pre-7.x install left one behind.
	if (pathExists(LEGACY_MODES_MARKER)) {
		unlinkSync(LEGACY_MODES_MARKER);
		console.log("• cleared legacy mode-system marker");
	}
	console.log("\n✓ Uninstalled the wiring. The LIFEOS/OMP tree + additive tool patches remain (harmless).");
}

function status(): void {
	const config = readConfig();
	const wired = new Set(currentExtensions(config));
	console.log(`agent dir: ${AGENT_DIR}`);
	console.log(`constitution symlink: ${isOurLink() ? "✓ linked" : "✗ not linked"}`);
	console.log("extensions:");
	for (const path of EXTENSION_PATHS) console.log(`  ${wired.has(path) ? "✓" : "✗"} ${path}`);
	const problems = verifySource();
	if (problems.length > 0) {
		console.log("source warnings:");
		for (const p of problems) console.log(`  ! ${p}`);
	} else {
		console.log("source: ✓ constitution + extensions + both tool patches present");
	}
	const backend = existsSync(INFERENCE_BACKEND_FILE) ? readFileSync(INFERENCE_BACKEND_FILE, "utf8").trim() : "claude (default)";
	console.log(`inference backend: ${backend}${backend.startsWith("omp") ? " — intelligence layer runs Claude-free" : ""}`);
}

/**
 * inference claude|omp|auto|status — pick the backend for the LifeOS intelligence
 * layer (MemoryReviewer, SatisfactionCapture — everything
 * through TOOLS/Inference.ts). 'omp' spawns bare omp sessions on OMP's own
 * default model/auth (any provider — point OMP at a new model and LifeOS
 * follows). 'auto' = claude first, omp on any claude failure (zero-config
 * subscription cutover). Env LIFEOS_INFERENCE_BACKEND overrides per-invocation.
 */
function inferenceBackend(state: string): void {
	if (state === "status" || state === "") {
		const v = existsSync(INFERENCE_BACKEND_FILE) ? readFileSync(INFERENCE_BACKEND_FILE, "utf8").trim() : "claude (default)";
		console.log(`inference backend: ${v}`);
		return;
	}
	if (state !== "claude" && state !== "omp" && state !== "auto") {
		console.error("Usage: bun manage.ts inference {claude|omp|auto|status}");
		process.exit(2);
	}
	if (state === "claude") {
		if (existsSync(INFERENCE_BACKEND_FILE)) unlinkSync(INFERENCE_BACKEND_FILE);
		console.log("✓ inference backend → claude (default restored; config file removed)");
		return;
	}
	mkdirSync(dirname(INFERENCE_BACKEND_FILE), { recursive: true });
	writeFileSync(INFERENCE_BACKEND_FILE, `${state}\n`, "utf8");
	console.log(`✓ inference backend → ${state} (${tildify(INFERENCE_BACKEND_FILE)})`);
	if (state === "omp") {
		console.log("  MemoryReviewer / SatisfactionCapture / Inference.ts consumers now spawn bare omp sessions.");
		console.log("  Model: OMP's own default (model-agnostic), or pin via LIFEOS_OMP_INFERENCE_MODEL. Effective immediately.");
	} else {
		console.log("  claude first; ANY claude failure (CLI gone, auth dead) retries once on a bare omp session.");
		console.log("  Cancel the Claude subscription and the intelligence layer follows OMP's default model automatically.");
	}
}

const command = process.argv[2];
if (command === "install") install();
else if (command === "uninstall") uninstall();
else if (command === "status") status();
else if (command === "modes") {
	console.error("`modes` was removed — upstream 7.0.0 retired the mode system (one unified format). Nothing to toggle.");
	process.exit(2);
}
else if (command === "inference") inferenceBackend(process.argv[3] ?? "");
else {
	console.error("Usage: bun manage.ts {install|uninstall|status|inference claude|omp|auto|status}");
	process.exit(2);
}
