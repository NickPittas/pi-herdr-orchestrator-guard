// Pure policy logic for herdr-orchestrator-guard.
// No Pi imports here so everything is unit-testable without a Pi runtime.

import { readFileSync, writeFileSync } from "node:fs";

/** The seven bundled Herdr agents a main session may spawn. */
export const HERDR_AGENTS = [
	"poteto",
	"worker",
	"scout",
	"planner",
	"reviewer",
	"adversarial-reviewer",
	"visual-tester",
] as const;

/** Allowed role component of a subagent name: <slug>-<role>[-n]. */
export const TASK_ROLES = [
	"plan",
	"research",
	"ui",
	"api",
	"build",
	"test",
	"review",
	"browser",
	"security",
	"perf",
	"merge",
] as const;

/** Labelled sections every delegated task / follow-up message must contain. */
export const REQUIRED_SECTIONS = [
	"Goal",
	"Allowed files",
	"Deliverables",
	"Verification",
	"Commit policy",
] as const;

/**
 * Exact default-deny allowlist for MAIN sessions when the guard is enabled:
 * Herdr orchestration tools + bounded read-only search/read + LSP diagnostic
 * navigation + ask_user_question + jev. Deliberately small — everything else
 * (shell, edits/writes, MCP, alternate spawners, unknown tools) is blocked.
 */
export const MAIN_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
	// Herdr orchestration
	"subagent",
	"subagent_send",
	"subagent_stop",
	"subagent_interrupt",
	"subagents_list",
	// read-only inspection
	"read",
	"grep",
	"find",
	"fffind",
	"ffgrep",
	// LSP diagnostic-navigation (read-only; excludes lsp_rename/lsp_code_actions/code_rewrite)
	"lsp_diagnostics",
	"lsp_definition",
	"lsp_hover",
	"lsp_references",
	"lsp_symbols",
	"code_overview",
	// user interaction / judgment primitives
	"ask_user_question",
	"jev",
]);

/**
 * Known alternate (non-Herdr) agent-spawning tools denied in CHILD sessions.
 * Children keep their execution tools; only these alternate spawners are
 * rejected. Herdr's own subagent tools stay available because poteto and
 * adversarial-reviewer legitimately delegate through Herdr, and Herdr's own
 * controls (self-spawn prevention, agent `spawning` defaults) govern that.
 */
export const CHILD_DENIED_TOOLS: ReadonlySet<string> = new Set([
	"agent",
	"subagentworkflow",
	"task",
	"delegate",
]);

const HERDR_AGENT_SET: ReadonlySet<string> = new Set<string>(HERDR_AGENTS);

export type ToolDecision = { action: "allow" } | { action: "block"; reason: string };

export interface ToolContext {
	enabled: boolean;
	isChild: boolean;
}

const RESUME_REASON =
	"Blocked by herdr-orchestrator-guard: subagent_resume cannot reliably prove session provenance. " +
	"Spawn a fresh named agent instead (agent: poteto|worker|scout|planner|reviewer|adversarial-reviewer|visual-tester, name: <slug>-<role>[-n]). " +
	"The user can disable the guard with /herdr-guard off if resuming is genuinely required.";

export function decideToolCall(toolName: string, ctx: ToolContext): ToolDecision {
	if (!ctx.enabled) return { action: "allow" };

	if (toolName === "subagent_resume") return { action: "block", reason: RESUME_REASON };

	if (ctx.isChild) {
		// Children keep their execution tools; only known alternate spawners are denied.
		if (CHILD_DENIED_TOOLS.has(toolName.toLowerCase())) {
			return {
				action: "block",
				reason:
					`Blocked by herdr-orchestrator-guard: '${toolName}' is a non-Herdr agent tool. ` +
					"Children must delegate through Herdr (subagent, subagent_send, ...) if delegation is part of their role.",
			};
		}
		return { action: "allow" };
	}

	if (MAIN_ALLOWED_TOOLS.has(toolName)) return { action: "allow" };
	return {
		action: "block",
		reason:
			`Blocked by herdr-orchestrator-guard: '${toolName}' is not on the main-session allowlist ` +
			"(Herdr orchestration tools, read/grep/find/fffind/ffgrep, LSP diagnostic navigation, ask_user_question, jev). " +
			"Delegate execution work through Herdr `subagent`. The user can disable with /herdr-guard off.",
	};
}

/** <slug>-<role>[-n], e.g. herdrguard-build-2, auth-api, ui-review-3. */
export const NAME_PATTERN = new RegExp(
	`^[a-z0-9][a-z0-9-]*-(${TASK_ROLES.join("|")})(-\\d+)?$`,
);

function headingPattern(section: string): RegExp {
	// Exact labelled heading at line start: "Goal:", "- Goal:", "## Goal",
	// "**Allowed files**:", "__Commit policy:__". The (?![a-zA-Z0-9]) boundary right
	// after the label rejects prefix matches like "Goals:" or "Goalkeeper".
	return new RegExp(
		`(?:^|\\n)[ \\t]*(?:[-*+]\\s+)?(?:#{1,6}[ \\t]+|\\*\\*|__)?${section}(?![a-zA-Z0-9])(?:\\*\\*|__)?[ \\t]*:?`,
		"i",
	);
}

/**
 * Returns the required sections that are missing or contentless. A section's
 * body runs to the START of the next required heading (the next label itself is
 * never counted as content) and must contain at least one letter or digit —
 * short but meaningful content like "No commits." passes, "..." does not.
 */
export function findMissingSections(text: string): string[] {
	const headings = REQUIRED_SECTIONS.flatMap((section) => {
		const match = headingPattern(section).exec(text);
		return match
			? [{ section, labelStart: match.index, contentStart: match.index + match[0].length }]
			: [];
	}).sort((a, b) => a.labelStart - b.labelStart);

	const missing: string[] = [];
	for (const [i, heading] of headings.entries()) {
		const end = i + 1 < headings.length ? headings[i + 1].labelStart : text.length;
		const body = text.slice(heading.contentStart, end).replace(/\s+/g, " ").trim();
		if (!/[a-zA-Z0-9]/.test(body)) missing.push(heading.section);
	}
	// Sections absent entirely keep their canonical order.
	for (const section of REQUIRED_SECTIONS) {
		if (!headings.some((h) => h.section === section)) missing.push(section);
	}
	return missing;
}

const SECTION_TEMPLATE =
	'Goal: ...\nAllowed files: ...\nDeliverables: ...\nVerification: ...\nCommit policy: ...';

const SPAWN_AGENTS_HINT = `one of: ${HERDR_AGENTS.join(", ")}`;
const NAME_HINT = `<slug>-<role>[-n] with role in ${TASK_ROLES.join("|")}`;

function sectionProblem(field: string): string {
	return (
		`'${field}' must contain substantive labelled sections ` +
		`(${REQUIRED_SECTIONS.join(", ")}), each label followed by nonempty content. ` +
		"Use this template:\n" +
		SECTION_TEMPLATE
	);
}

/** Validates a `subagent` call. Returns a block reason or null when acceptable. */
export function validateSpawn(input: Record<string, unknown>): string | null {
	const problems: string[] = [];

	const agent = input.agent;
	if (typeof agent !== "string" || agent.length === 0) {
		problems.push(`'agent' is required (bare spawns rejected). Use ${SPAWN_AGENTS_HINT}.`);
	} else if (!HERDR_AGENT_SET.has(agent as (typeof HERDR_AGENTS)[number])) {
		problems.push(`'agent' must be a bundled Herdr agent ${SPAWN_AGENTS_HINT}. Got '${agent}'.`);
	}

	const name = input.name;
	if (typeof name !== "string" || !NAME_PATTERN.test(name.toLowerCase())) {
		problems.push(`'name' must match ${NAME_HINT}. Got '${name}'.`);
	}

	for (const field of ["systemPrompt", "tools", "skills"] as const) {
		if (input[field] !== undefined) {
			problems.push(`'${field}' override is rejected; named agents keep their definition.`);
		}
	}
	if (input.model !== undefined) {
		problems.push(
			"Explicit 'model' override is rejected. Omit 'model' to use the current Herdr defaults " +
				"(agent frontmatter + your models.agents / task-model preferences).",
		);
	}

	if (typeof input.task !== "string") {
		problems.push("'task' (string) is required.");
	} else {
		const missing = findMissingSections(input.task);
		if (missing.length > 0) {
			problems.push(`${sectionProblem("task")} Missing/empty: ${missing.join(", ")}.`);
		}
	}

	return problems.length > 0
		? `Blocked by herdr-orchestrator-guard:\n- ${problems.join("\n- ")}`
		: null;
}

/** Validates a `subagent_send` follow-up. Returns a block reason or null. */
export function validateSend(input: Record<string, unknown>): string | null {
	const problems: string[] = [];

	if ((!input.id || typeof input.id !== "string") && (!input.name || typeof input.name !== "string")) {
		problems.push("'subagent_send' requires 'id' or 'name' to address the persistent specialist.");
	}

	if (typeof input.message !== "string") {
		problems.push("'message' (string) is required.");
	} else {
		const missing = findMissingSections(input.message);
		if (missing.length > 0) {
			problems.push(`${sectionProblem("message")} Missing/empty: ${missing.join(", ")}.`);
		}
	}

	return problems.length > 0
		? `Blocked by herdr-orchestrator-guard:\n- ${problems.join("\n- ")}`
		: null;
}

// ── persisted state (extension-owned JSON next to index.ts) ──

export interface GuardState {
	enabled: boolean;
}

export function loadState(filePath: string): GuardState {
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		const enabled =
			typeof parsed === "object" && parsed !== null && "enabled" in parsed
				? (parsed as { enabled: unknown }).enabled !== false
				: true;
		return { enabled };
	} catch {
		return { enabled: true }; // default: enabled
	}
}

export function saveState(filePath: string, enabled: boolean): void {
	writeFileSync(filePath, `${JSON.stringify({ enabled }, null, 2)}\n`);
}

/** Short protocol injected into the MAIN session system prompt (section add, not a full override). */
export const PROTOCOL_SECTION = `Herdr-only orchestration is enforced by herdr-orchestrator-guard.
- Delegate exclusively through Herdr tools: subagent, subagent_send, subagent_stop, subagent_interrupt, subagents_list. Shell, file edits/writes, MCP, and all other spawning tools are blocked in this session.
- subagent: agent must be ${HERDR_AGENTS.join("|")}; name must be <slug>-<role>[-n] with role in ${TASK_ROLES.join("|")}.
- Every task (and subagent_send message) must contain substantive labelled sections: ${REQUIRED_SECTIONS.join(", ")}.
- Never pass model, systemPrompt, tools, or skills overrides. Omit 'model' to use current Herdr defaults.
- subagent_resume is blocked; spawn a fresh named agent instead.`;
