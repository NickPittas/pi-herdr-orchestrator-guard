# pi-herdr-orchestrator-guard

Pi extension guarding **Herdr orchestration**. When enabled, the main session is
guided to delegate substantial independent work through Herdr while keeping its
ordinary tools (edit, write, bash, read, MCP, ...) for small direct tasks.
Known non-Herdr agent tools are denied by name, Herdr delegations are strictly
validated, and child sessions keep their execution tools.

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
pi install git:github.com/NickPittas/pi-herdr-orchestrator-guard@v0.1.2
```

> **Note:** the `v0.1.2` tag does not exist yet — install only once it has been
> published to the remote. Until then, `v0.1.1` remains the latest installable
> tag (with the older default-deny policy).

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

Main sessions keep their ordinary tools — `edit`, `write`, `bash`/`powershell`,
`read`/`grep`/`find`/..., MCP tools, and any unknown general tool all pass
through. The guard only denies:

- **Known non-Herdr agent tools** by exact case-insensitive name: `agent`,
  `SubagentWorkflow`, `task`, `delegate`. Delegate through Herdr instead.
- **`subagent_resume`** always: session provenance cannot be reliably proven,
  so spawn a fresh named agent instead.

Delegation is *preferred* for substantial independent work, not forced for every
line: small fixes, inspection, and shell tasks are fine directly. The injected
protocol (below) states this guidance; the runtime enforcement is the two
denials above plus the validation below.

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

### Child sessions (`PI_SUBAGENT_ID` set)

Children **keep their execution tools** (`bash`, `edit`, `write`, ...). The same
known non-Herdr agent tools are denied (`agent`, `SubagentWorkflow`, `task`,
`delegate`, case-insensitive). This is deliberately *not* an all-leaf policy:
`poteto` and `adversarial-reviewer` legitimately delegate through Herdr, and
Herdr's own controls (self-spawn prevention, agent `spawning` defaults) decide
whether spawning is allowed.

### Prompt protocol

A short protocol section (`herdr_orchestrator_guard`) is injected via
`before_agent_start` on **every** main-session run (Pi rebuilds prompt sections
per run, so a once-only flag would silently lose it) and removed while disabled
or in child sessions. It instructs the main session to prefer Herdr delegation
for substantial independent work, names the blocked non-Herdr agent tools
explicitly, and carries the delegation-structure rules. The entire system
prompt is **never** overridden.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Extension factory: `/herdr-guard` command, `tool_call` interception, protocol injection |
| `policy.ts` | Pure validation/decision logic (no Pi imports) |
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
- **Indirect spawns through shell/MCP are not interceptable.** Enforcement is
  tool-name based: it denies the `agent`/`SubagentWorkflow`/`task`/`delegate`
  *tools*, but it cannot provably intercept a non-Herdr agent spawned
  indirectly — e.g. a `bash` command that launches another CLI, or an MCP tool
  that spawns a model call. Naive shell-content regexes would block everyday
  code strings, so none is attempted. Treat shell/MCP escape hatches as out of
  scope for this guard.
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

## License

[MIT](LICENSE) © NickPittas
