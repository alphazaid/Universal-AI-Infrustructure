import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createWorkState(): { lifeosDir: string; workJson: string } {
	const lifeosDir = mkdtempSync(join(tmpdir(), "lifeos-observability-"));
	tempDirs.push(lifeosDir);
	const stateDir = join(lifeosDir, "MEMORY", "STATE");
	mkdirSync(stateDir, { recursive: true });
	const workJson = join(stateDir, "work.json");
	writeFileSync(workJson, JSON.stringify({
		sessions: {
			"current-session": { phase: "execute", effort: "E3", updatedAt: "2020-01-01T00:00:00.000Z" },
			"other-session": { phase: "verify", effort: "E5", updatedAt: "2099-01-01T00:00:00.000Z" },
			"completed-session": { phase: "complete", effort: "E4", updatedAt: "2099-01-01T00:00:00.000Z" },
		},
	}));
	return { lifeosDir, workJson };
}

describe("LifeOS depth indicator", () => {
	test("renders only the current OMP session's Algorithm state", async () => {
		const { lifeosDir, workJson } = createWorkState();
		const previousLifeosDir = process.env.LIFEOS_DIR;
		process.env.LIFEOS_DIR = lifeosDir;
		try {
			// Import after LIFEOS_DIR is isolated; the extension resolves its state path at module load.
			const extension = await import(`./index.ts?test=${Date.now()}`);
			const event = {
				toolName: "edit",
				input: {
					content: "x".repeat(400),
					file_path: "/tmp/MEMORY/WORK/current-session/ISA.md",
				},
			};

			expect(extension.workSlugFromToolEvent(event)).toBe("current-session");
			expect(extension.workSlugFromToolEvent({
				input: { path: "C:\\Users\\test\\MEMORY\\WORK\\windows-session\\ISA.md" },
			})).toBe("windows-session");
			expect(extension.depthTagForSession("current-session", workJson)).toBe(" · ALGO execute E3");
			expect(extension.depthTagForSession("completed-session", workJson)).toBe(" · DIRECT");
			expect(extension.depthTagForSession("", workJson)).toBe(" · DIRECT");

			const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
			extension.default({
				on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
				setLabel: () => undefined,
				registerCommand: () => undefined,
			});

			let status = "";
			const ctx = {
				hasUI: true,
				ui: {
					setStatus: (_key: string, value: string) => { status = value; },
					setWidget: () => undefined,
					notify: () => undefined,
				},
			};

			handlers.get("session_start")?.({}, ctx);
			expect(status).toBe("LifeOS · 🔧0 · DIRECT");

			await handlers.get("tool_execution_end")?.(event, ctx);
			expect(status).toBe("LifeOS · 🔧1 · ALGO execute E3");
			expect(status).not.toContain("verify");
			expect(status).not.toContain("E5");
		} finally {
			if (previousLifeosDir === undefined) delete process.env.LIFEOS_DIR;
			else process.env.LIFEOS_DIR = previousLifeosDir;
		}
	});
});
