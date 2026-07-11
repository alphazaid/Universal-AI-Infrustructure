/**
 * lifeos-commands — OMP slash commands for the LifeOS effort levers.
 *
 *   /e1 .. /e5 [task]  -> raise the native reasoning budget (setThinkingLevel) for the
 *                         task, the faithful analog of Claude-Code effort overrides that
 *                         changed routing rather than just prompt text, then submit [task]
 *                         with the LifeOS effort suffix the constitution also honors.
 *   /interview [focus] -> kick the LifeOS Interview skill to review/fill TELOS + identity.
 *   /modes [on|off]    -> toggle the LifeOS mode system (delegates to manage.ts so the
 *                         constitution variant + enforcement marker swap atomically);
 *                         no arg reports current state. Takes effect next session.
 *
 * Thinking-budget mapping (OMP levels: off|minimal|low|medium|high|xhigh|auto):
 *   e1 Standard -> low   e2 Extended -> medium   e3 Advanced -> high
 *   e4 Deep -> xhigh      e5 Comprehensive -> xhigh
 * Runtime actions (setThinkingLevel, sendUserMessage) are called from handlers, never at
 * factory load, where they are not yet initialized.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const HOME = homedir();
const MANAGE = join(HOME, ".claude", "LIFEOS", "OMP", "manage.ts");
const MODES_MARKER = join(process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".omp", "agent"), "lifeos-modes.on");
const BUN_BIN = existsSync(join(HOME, ".bun/bin/bun")) ? join(HOME, ".bun/bin/bun") : "bun";
interface ExtensionApi {
	registerCommand: (
		name: string,
		def: { description: string; handler: (args: string, ctx: { ui?: { notify?: (message: string, level?: string) => void } }) => unknown },
	) => void;
	sendUserMessage?: (content: string, opts?: { deliverAs?: string }) => unknown;
	setThinkingLevel?: (level: string) => void;
	setLabel?: (label: string) => void;
}

const TIER_THINKING: Record<number, string> = { 1: "low", 2: "medium", 3: "high", 4: "xhigh", 5: "xhigh" };

export default function lifeosCommands(pi: ExtensionApi): void {
	pi.setLabel?.("LifeOS Commands");

	for (const tier of [1, 2, 3, 4, 5]) {
		pi.registerCommand(`e${tier}`, {
			description: `LifeOS effort tier ${tier} — raise reasoning budget to '${TIER_THINKING[tier]}' and run the task with Algorithm-style rigor`,
			handler: (args) => {
				pi.setThinkingLevel?.(TIER_THINKING[tier]);
				const task = args.trim();
				if (task.length > 0) pi.sendUserMessage?.(`${task} /e${tier}`, { deliverAs: "followUp" });
			},
		});
	}

	pi.registerCommand("interview", {
		description: "Run the LifeOS Interview skill to review/fill your TELOS + identity",
		handler: (args) => {
			const focus = args.trim();
			const suffix = focus.length > 0 ? `, focusing on: ${focus}` : "";
			pi.sendUserMessage?.(
				`Use the Interview skill (skill://Interview) to review and fill my LifeOS context${suffix}.`,
				{ deliverAs: "followUp" },
			);
		},
	});

	// CC-parity shortcuts — ~/.claude/commands/{cs,context-search,pu}.md are thin skill
	// redirects in Claude Code; mirror them as skill invocations here.
	const SKILL_SHORTCUTS: Record<string, { skill: string; description: string }> = {
		cs: { skill: "ContextSearch", description: "Search prior work/sessions for context (ContextSearch skill)" },
		"context-search": { skill: "ContextSearch", description: "Search prior work/sessions for context (ContextSearch skill)" },
		pu: { skill: "Upgrade", description: "Scan sources + bookmarks for LifeOS upgrades (Upgrade skill)" },
	};
	for (const [name, def] of Object.entries(SKILL_SHORTCUTS)) {
		pi.registerCommand(name, {
			description: def.description,
			handler: (args) => {
				const rest = args.trim();
				const withArgs = rest.length > 0 ? ` with: ${rest}` : "";
				pi.sendUserMessage?.(`Use the ${def.skill} skill (skill://${def.skill})${withArgs}.`, { deliverAs: "followUp" });
			},
		});
	}

	pi.registerCommand("modes", {
		description: "LifeOS mode system: /modes on | off | (no arg = show state). Applies to the NEXT session.",
		handler: async (args, ctx) => {
			const want = args.trim().toLowerCase();
			const notify = (message: string, level = "info") => ctx.ui?.notify?.(message, level);
			if (want !== "on" && want !== "off") {
				notify(`LifeOS modes: ${existsSync(MODES_MARKER) ? "ON (banners + router)" : "off"} — use /modes on|off`);
				return;
			}
			// Async spawn — never block the shared event loop (the spawnSync freeze lesson).
			const { promise, resolve } = Promise.withResolvers<number | null>();
			try {
				const child = spawn(BUN_BIN, [MANAGE, "modes", want], { stdio: ["ignore", "ignore", "ignore"] });
				child.on("close", (code) => resolve(code));
				child.on("error", () => resolve(null));
			} catch {
				resolve(null);
			}
			const code = await promise;
			if (code === 0) notify(`LifeOS modes ${want.toUpperCase()} — takes effect in your NEXT omp session`, "info");
			else notify(`modes toggle failed (exit ${code ?? "spawn-error"}) — run: bun ~/.claude/LIFEOS/OMP/manage.ts modes ${want}`, "error");
		},
	});
}
