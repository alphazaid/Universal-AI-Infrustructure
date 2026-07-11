# LifeOS ↔ OMP (Oh My Pi) Integration

Runs LifeOS inside the [Oh My Pi](https://github.com/) harness (`omp`) using OMP's native
extensibility, so a LifeOS install governs OMP sessions the way it governs Claude Code —
without forking either system. LifeOS is harness-agnostic by design; this is a concrete
second-harness adapter built on OMP's public extension API.

## What it provides

| Piece | Mechanism |
|---|---|
| **Constitution** | `APPEND_SYSTEM.md` (modes-off) / `APPEND_SYSTEM_MODES.md` (modes-on, full CC banner templates) → `~/.omp/agent/APPEND_SYSTEM.md`. Swap with `manage.ts modes on\|off`. |
| **Memory** | `extensions/lifeos-memory` — injects the hot-layer `<pai-memory>` block + prompt-keyed KNOWLEDGE retrieval each turn (ports `LoadMemory` + `MemoryRetriever`). |
| **Safety** | `extensions/lifeos-safety` — native in-process port of `Safety.hook.ts`: blocks dangerous-shape/injection/credential tool calls, tags external content as data. |
| **Hook adapter** | `extensions/lifeos-hooks` — runs the *real* LifeOS Claude Code hooks against mapped OMP events (CC stdin/stdout protocol) with a `CLAUDE_*` env shim, tool-name mapping, Pulse-availability gating, and the mode-system toggle (TheRouter + OutputFormatGate when modes are on). |
| **Observability** | `extensions/lifeos-observability` — native ToolActivityTracker + ToolFailureTracker (CC jsonl schemas, so Pulse reads both harnesses) + a LifeOS statusline. |
| **Commands** | `extensions/lifeos-commands` — `/e1`–`/e5` (native `setThinkingLevel`), `/interview`, `/cs`, `/context-search`, `/pu`. |

Identity, TELOS, skills, and MCP servers already flow into OMP via its `claude` discovery
provider, so this subsystem only supplies what that provider does not: the constitution,
the hooks, and memory injection.

Full per-hook accounting — what is ported, what is not, why, and what makes this full possible parity: [PARITY.md](./PARITY.md).

## Install / uninstall

```bash
LIFEOS/OMP/install.sh      # wire into ~/.omp/agent (idempotent, YAML-safe, backs up config)
LIFEOS/OMP/uninstall.sh    # remove wiring; leaves this tree + tool patches (harmless)
bun LIFEOS/OMP/manage.ts status   # what's wired
```

Respects `PI_CODING_AGENT_DIR` (works under `omp --profile`). Reversal removes the five
`extensions:` entries from `config.yml`, the `APPEND_SYSTEM.md` symlink, and the modes marker.
Mode system: `bun LIFEOS/OMP/manage.ts modes on|off` swaps the constitution variant and the
enforcement marker together (they can never disagree).
Inference backend: `bun LIFEOS/OMP/manage.ts inference claude|omp|auto|status` — `omp` re-points
the intelligence layer (TheRouter, MemoryReviewer, SatisfactionCapture — everything through
`TOOLS/Inference.ts`) at bare `omp` spawns on **OMP's own default model** (model-agnostic: point
OMP at any provider/model and LifeOS follows). `auto` = claude first, one omp retry on ANY claude
failure — the zero-config subscription cutover. Env `LIFEOS_INFERENCE_BACKEND` /
`LIFEOS_OMP_INFERENCE_MODEL` override per-invocation. Pin models by fully-qualified id
(`provider/model`) — fuzzy names can resolve to an unauthenticated provider's copy.

## CC→OMP event map (adapter)

`SessionStart→session_start` · `UserPromptSubmit→before_agent_start` · `PreToolUse→tool_call` ·
`PostToolUse→tool_result` · `Stop→session_stop` · `SessionEnd→session_shutdown`.

Bridged hooks are curated for safety: Pulse-coupled hooks are gated behind a liveness probe;
the mode system (`TheRouter` + `OutputFormatGate`) is opt-in via `manage.ts modes on` because
it adds a per-turn classifier and mandatory banners. Stop-hook stdout is informational only —
the adapter continues a turn ONLY on an explicit `decision:block`. Hooks with no OMP analog
(terminal tabs, CC settings sync) and the hooks not wired in Claude Code's own
`settings.json` are intentionally not bridged.

## Three additive tool patches (harness-agnostic, CC-safe)

- `LIFEOS/TOOLS/MemoryReviewer.ts` — `findMostRecentTranscript()` also scans
  `~/.omp/agent/sessions`, so the autonomic memory loop reviews OMP sessions.
- `LIFEOS/TOOLS/TranscriptParser.ts` — `textMessageFromEntry()`/`isRealUserPrompt()` read OMP's
  nested `type:"message"` `{ message: { role, content } }` line shape alongside Claude Code's
  `type:"assistant"`, Codex's `response_item`, and OpenCode's top-level `type:"message"`.
- `LIFEOS/TOOLS/Inference.ts` — optional `omp` backend (see "Inference backend" above);
  default stays `claude`, so Claude Code / Codex setups are untouched.

All are additive; Claude Code behavior is unchanged.

## Design notes

- **Adapter over rewrite** — the adapter runs the real hook files, so logic stays
  single-sourced with Claude Code and does not drift.
- **Fail-open** — any adapter/hook error contributes nothing; the turn is only ever blocked
  by an explicit hook `decision:block`.
- **No private data** — every file resolves paths via `homedir()`/env; nothing principal-
  specific is baked in.

## Verifying (fresh system)

Per LifeOS's contributing guidance ("test in a fresh system"). Requires a LifeOS install,
`omp`, and `bun`.

1. `bun LIFEOS/OMP/manage.ts install` → wires the 5 extensions + constitution symlink.
2. `bun LIFEOS/OMP/manage.ts status` → all five extensions and the symlink show ✓; source
   check reports the constitution, extensions, and both tool patches present.
3. Open a fresh `omp` session (or `omp --print "hi"`). Confirm:
   - a `<pai-memory>` block is in context (the `## PRINCIPAL MEMORY [N/48 …]` header);
   - the constitution loaded (asked to emit `════ MODE ════` banners, it declines — not required in OMP).
4. Safety: ask it to run `chmod -R 777 /tmp/nonexistent` → blocked with
   `LifeOS Safety blocked Bash: dangerous-shape …`; a benign `echo` passes.
5. `bun LIFEOS/OMP/manage.ts uninstall` → wiring removed; other `config.yml` keys intact;
   stock OMP restored.
