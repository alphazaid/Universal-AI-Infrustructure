import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookEnv } from "./index";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Claude-free OMP inference", () => {
	test("marks bridged hook subprocesses as OMP", () => {
		expect(hookEnv({ cwd: "/tmp/project" }).LIFEOS_HARNESS).toBe("omp");
	});

	test("uses OMP without attempting Claude when no backend is configured", async () => {
		const home = mkdtempSync(join(tmpdir(), "lifeos-omp-backend-"));
		tempDirs.push(home);
		const binDir = join(home, "bin");
		const claudeSentinel = join(home, "claude-called");
		mkdirSync(binDir);

		const ompBin = join(binDir, "omp");
		writeFileSync(ompBin, "#!/bin/sh\nprintf 'OMP_STUB_OK\\n'\n");
		chmodSync(ompBin, 0o755);

		const claudeBin = join(binDir, "claude");
		writeFileSync(claudeBin, `#!/bin/sh\nprintf called > '${claudeSentinel}'\nprintf 'CLAUDE_STUB\\n'\n`);
		chmodSync(claudeBin, 0o755);

		const inferencePath = join(import.meta.dir, "../../../TOOLS/Inference.ts");
		const probe = [
			`import { inference } from ${JSON.stringify(inferencePath)};`,
			"const result = await inference({ level: 'low', systemPrompt: 'Return the stub response.', userPrompt: 'probe', timeout: 3000 });",
			"console.log(JSON.stringify(result));",
			"if (!result.success) process.exit(1);",
		].join("\n");
		const childEnv = { ...process.env, HOME: home, PATH: binDir, LIFEOS_HARNESS: "omp" };
		delete childEnv.LIFEOS_INFERENCE_BACKEND;
		delete childEnv.LIFEOS_OMP_INFERENCE_MODEL;
		const child = Bun.spawn([process.execPath, "--eval", probe], {
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim()).output).toBe("OMP_STUB_OK");
		expect(stderr).not.toContain("claude backend");
		expect(existsSync(claudeSentinel)).toBe(false);
	});

	test("supports explicit Claude opt-in and automatic OMP reset", async () => {
		const home = mkdtempSync(join(tmpdir(), "lifeos-manage-backend-"));
		tempDirs.push(home);
		const managePath = join(import.meta.dir, "../../manage.ts");
		const configPath = join(home, ".claude/LIFEOS/USER/CONFIG/inference-backend");
		const runManage = async (...args: string[]) => {
			const child = Bun.spawn([process.execPath, managePath, "inference", ...args], {
				env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout, stderr, exitCode };
		};

		const initial = await runManage("status");
		expect(initial.exitCode).toBe(0);
		expect(initial.stdout).toContain("omp (automatic OMP default; Claude-free)");

		const claude = await runManage("claude");
		expect(claude.exitCode).toBe(0);
		expect(claude.stdout).toContain("Explicit Claude CLI backend selected");
		expect(existsSync(configPath)).toBe(true);
		expect((await runManage("status")).stdout).toContain("claude (explicit override)");

		const reset = await runManage("default");
		expect(reset.exitCode).toBe(0);
		expect(reset.stdout).toContain("omp (automatic OMP default");
		expect(existsSync(configPath)).toBe(false);
	});

	test("installs into a missing OMP agent directory", async () => {
		const home = mkdtempSync(join(tmpdir(), "lifeos-manage-install-"));
		tempDirs.push(home);
		const agentDir = join(home, ".omp/agent");
		const managePath = join(import.meta.dir, "../../manage.ts");
		const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir };

		const install = Bun.spawn([process.execPath, managePath, "install"], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [installStdout, installStderr, installExitCode] = await Promise.all([
			new Response(install.stdout).text(),
			new Response(install.stderr).text(),
			install.exited,
		]);

		expect(installExitCode).toBe(0);
		expect(installStderr).toBe("");
		expect(installStdout).toContain("5 added");
		expect(existsSync(join(agentDir, "config.yml"))).toBe(true);
		expect(existsSync(join(agentDir, "APPEND_SYSTEM.md"))).toBe(true);

		const status = Bun.spawn([process.execPath, managePath, "status"], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const statusStdout = await new Response(status.stdout).text();
		expect(await status.exited).toBe(0);
		expect(statusStdout).not.toContain("✗");
		expect(statusStdout).toContain("omp (automatic OMP default) — intelligence layer runs Claude-free");
	});
});
