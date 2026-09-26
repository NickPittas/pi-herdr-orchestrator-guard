# pi-herdr-orchestrator-guard

Pi extension enforcing **Herdr-only orchestration**. When enabled, the main
session becomes a pure orchestrator: it may only delegate through Herdr subagent
tools plus a bounded read-only toolset, and every delegation must follow a strict
task structure. Child sessions keep their execution tools.

## Requirements & Install

### 1. Install Herdr first (required)

This guard is a policy layer on top of [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents):
it validates the orchestrator's delegated calls, but it does **not** ship or
install Herdr itself. pi-herdr-agents must be installed and active before the
guard has anything to enforce against:

```bash
pi install npm:pi-herdr-agents
```

Confirm it is active with `pi list` — you should see `pi-herdr-agents` among the
installed packages.

### 2. Install the guard

```bash
pi install git:github.com/NickPittas/pi-herdr-orchestrator-guard@v0.1.1
```

To try it without installing:

```bash
pi -e git:github.com/NickPittas/pi-herdr-orchestrator-guard
```

> **Do not run two copies.** If you previously used a local copy of this
> extension under `~/.pi/agent/extensions/herdr-orchestrator-guard/`, remove
> that directory (or the `pi install` declaration) before installing the
> package. Personal extensions directories load automatically and independently
> of packages, so keeping both would register duplicate tool-call hooks and a
> duplicate `/herdr-guard` command. Check with `pi list` and `pi config`.

## Usage

```
/herdr-guard status    # show current state
/herdr-guard off       # disable immediately (this session + persisted)
/herdr-guard on        # re-enable
```

State is persisted to `state.json` in the installed package directory
(extension-owned, created on first toggle, gitignored). **Default: enabled.**
Toggles take effect immediately — no reload needed.

## What it enforces (when enabled)

### Main sessions (no `PI_SUBAGENT_ID`)

Exact default-deny allowlist — everything not listed is blocked:

- **Herdr orchestration**: `subagent`, `subagent_send`, `subagent_stop`,
  `subagent_interrupt`, `subagents_list`
- **Read-only inspection**: `read`, `grep`, `find`, `fffind`, `ffgrep`
- **LSP diagnostic navigation**: `lsp_diagnostics`, `lsp_definition`, `lsp_hover`,
  `lsp_references`, `lsp_symbols`, `code_overview`
- **Interaction / judgment**: `ask_user_question`, `jev`

Explicitly blocked: `bash`/`powershell`, `edit`/`write`, `mcp`/`mcpScript`,
alternate spawners (`agent`, `SubagentWorkflow`, ...), `lsp_rename`/`lsp_code_actions`/
`code_rewrite`, `subagent_resume`, and any unknown tool.

`subagent` calls are validated:

- `agent` must be one of the seven bundled Herdr agents: `poteto`, `worker`,
  `scout`, `planner`, `reviewer`, `adversarial-reviewer`, `visual-tester`
  (bare spawns rejected)
- `name` must be `<slug>-<role>[-n]` with role in
  `plan|research|ui|api|build|test|review|browser|security|perf|merge`
- `task` must contain substantive labelled sections: **Goal, Allowed files,
  Deliverables, Verification, Commit policy** — exact labels (no prefixes like
  "Goals:"), each followed by nonempty content (short but real content like
  "No commits." suffices; placeholder-only bodies like "..." are rejected);
  missing or contentless sections are rejected with the template in the block reason
- overrides rejected: `model` (omit it to use current Herdr defaults — your
  `models.agents` / task-model preferences stay authoritative), `systemPrompt`,
  `tools`, `skills`

`subagent_send` messages get the same section-structure validation and must
address the specialist via `id` or `name`.

`subagent_resume` is always blocked: session provenance cannot be reliably
proven, so spawn a fresh named agent instead.

### Child sessions (`PI_SUBAGENT_ID` set)

Children **keep their execution tools** (`bash`, `edit`, `write`, ...). Only known
alternate (non-Herdr) agent tools are denied (`agent`, `SubagentWorkflow`, `task`,
`delegate`, case-insensitive). This is deliberately *not* an all-leaf policy:
`poteto` and `adversarial-reviewer` legitimately delegate through Herdr, and
Herdr's own controls (self-spawn prevention, agent `spawning` defaults) decide
whether spawning is allowed.

### Prompt protocol

A short protocol section (`herdr_orchestrator_guard`) is injected via
`before_agent_start` on **every** main-session run (Pi rebuilds prompt sections
per run, so a once-only flag would silently lose it) and removed while disabled
or in child sessions. The entire system prompt is **never** overridden.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Extension factory: `/herdr-guard` command, `tool_call` interception, protocol injection |
| `policy.ts` | Pure validation/allowlist logic (no Pi imports) |
| `test.ts` | Unit + mocked-hook integration tests |
| `state.json` | Extension-owned persisted on/off state; created at runtime on first toggle, gitignored, never shipped |

## Tests

```bash
npm test
# or directly:
node --experimental-strip-types --test test.ts
```

## Limitations (read before trusting this)

- **Policy, not a sandbox.** The extension runs inside Pi with the same OS
  permissions as Pi. It blocks tool calls by name; it cannot contain arbitrary
  code execution. A determined model that finds an unblocked escape hatch (or a
  tool renamed by another extension) bypasses it.
- **Same-name tools are trusted.** Blocking and validation are by tool *name*
  and argument shape. If another extension registers a tool with an allowlisted
  name but different behavior, the guard cannot prove ownership and will trust it.
- **Arbitrary worker code is outside enforcement.** Once a Herdr child runs, its
  behavior is governed by its own agent definition and Herdr's controls — this
  guard only filters which tools the child is denied (alternate agent tools).
- **Structure ≠ semantics.** Task sections are validated for presence and
  nonempty real content, not for quality or truthfulness of that content.
- **Unknown internal invocations.** The guard makes no guarantees about agent
  invocations that do not go through Pi's `tool_call` event (e.g. nested model
  calls, external CLIs launched outside Pi, future Herdr spawn paths).
- `ls` is not on the allowlist (kept intentionally small per policy); read-only
  file inspection is available via `read`/`grep`/`find`/`fffind`/`ffgrep`.
- `ast_search` (pi-lsp-extension) is not allowlisted; add it to
  `MAIN_ALLOWED_TOOLS` in `policy.ts` if you want it.

## License

[MIT](LICENSE) © NickPittas
