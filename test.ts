// Unit + mocked-hook integration tests for herdr-orchestrator-guard.
// Run: node --experimental-strip-types --test <this-dir>/test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	CHILD_DENIED_TOOLS,
	MAIN_ALLOWED_TOOLS,
	PROTOCOL_SECTION,
	REQUIRED_SECTIONS,
	decideToolCall,
	findMissingSections,
	loadState,
	saveState,
	validateSend,
	validateSpawn,
} from "./policy.ts";
import herdrOrchestratorGuard from "./index.ts";

const GOOD_TASK = [
	"Goal: Implement the parser module for the config service.",
	"Allowed files: src/parser.ts, src/parser.test.ts only.",
	"Deliverables: Working parser with unit tests passing.",
	"Verification: run node --test src/parser.test.ts and report output.",
	"Commit policy: do not commit; the parent session integrates.",
].join("\n");

let tmpDir: string;

function makeMockPi() {
	const handlers = new Map<string, Array<(event: any, ctx?: any) => any>>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();
	const pi = {
		on: (name: string, fn: (event: any, ctx?: any) => any) => {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
			return () => {};
		},
		registerCommand: (name: string, opts: { description?: string; handler: (args: string, ctx: any) => Promise<void> }) =>
			commands.set(name, opts),
	};
	const dispatch = (name: string, event: any, ctx?: any) => {
		let result: any;
		for (const fn of handlers.get(name) ?? []) result = fn(event, ctx);
		return result;
	};
	return { pi, handlers, commands, dispatch };
}

function makeCommandCtx() {
	const notifications: Array<{ text: string; level: string }> = [];
	const ctx = { hasUI: true, ui: { notify: (text: string, level: string = "info") => notifications.push({ text, level }) } };
	return { ctx, notifications };
}

describe("validateSpawn (subagent)", () => {
	it("accepts a fully valid spawn", () => {
		const err = validateSpawn({ agent: "worker", name: "herdrguard-build-2", task: GOOD_TASK });
		assert.equal(err, null);
	});

	it("accepts every bundled agent name", () => {
		for (const agent of ["poteto", "worker", "scout", "planner", "reviewer", "adversarial-reviewer", "visual-tester"]) {
			assert.equal(validateSpawn({ agent, name: `${agent}-research`, task: GOOD_TASK }), null, agent);
		}
	});

	it("accepts name with numeric suffix and all roles", () => {
		for (const role of ["plan", "research", "ui", "api", "build", "test", "review", "browser", "security", "perf", "merge"]) {
			assert.equal(validateSpawn({ agent: "worker", name: `auth-${role}-3`, task: GOOD_TASK }), null, role);
		}
	});

	it("rejects missing agent (bare spawn)", () => {
		const err = validateSpawn({ name: "auth-build", task: GOOD_TASK });
		assert.match(err!, /'agent' is required/);
	});

	it("rejects unknown agent", () => {
		const err = validateSpawn({ agent: "generic-helper", name: "auth-build", task: GOOD_TASK });
		assert.match(err!, /must be a bundled Herdr agent/);
	});

	it("rejects names without a valid role", () => {
		assert.match(validateSpawn({ agent: "worker", name: "auth", task: GOOD_TASK })!, /'name' must match/);
		assert.match(validateSpawn({ agent: "worker", name: "auth-execute", task: GOOD_TASK })!, /'name' must match/);
		assert.match(validateSpawn({ agent: "worker", name: "build", task: GOOD_TASK })!, /'name' must match/);
	});

	it("rejects systemPrompt, tools and skills overrides", () => {
		for (const field of ["systemPrompt", "tools", "skills"]) {
			const err = validateSpawn({ agent: "worker", name: "auth-build", task: GOOD_TASK, [field]: "x" });
			assert.match(err!, new RegExp(`'${field}' override is rejected`));
		}
	});

	it("rejects explicit model override and explains omit-model", () => {
		const err = validateSpawn({ agent: "worker", name: "auth-build", task: GOOD_TASK, model: "anthropic/claude-x" });
		assert.match(err!, /'model' override is rejected/);
		assert.match(err!, /Omit 'model' to use the current Herdr defaults/);
	});

	it("rejects task missing required sections and names them", () => {
		const err = validateSpawn({ agent: "worker", name: "auth-build", task: "Goal: fix the thing quickly please." });
		assert.match(err!, /Missing\/empty: Allowed files, Deliverables, Verification, Commit policy/);
	});

	it("rejects contentless sections (punctuation-only bodies)", () => {
		const punct = "Goal: ...\nAllowed files: ---\nDeliverables: ***\nVerification: [...]\nCommit policy: ...";
		const err = validateSpawn({ agent: "worker", name: "auth-build", task: punct });
		assert.match(err!, /Missing\/empty: Goal, Allowed files, Deliverables, Verification, Commit policy/);
	});
});

describe("findMissingSections", () => {
	it("accepts markdown-style headings and all canonical sections", () => {
		const md = [
			"## Goal",
			"Build the export pipeline end to end.",
			"**Allowed files**: src/export.ts and tests only.",
			"- Deliverables: PR-ready module with docs.",
			"__Verification__: npm test must pass cleanly.",
			"Commit policy: worker never commits; parent integrates.",
		].join("\n");
		assert.deepEqual(findMissingSections(md), []);
	});

	it("reports missing sections in canonical order", () => {
		assert.deepEqual(
			findMissingSections("Goal: one two three four five six."),
			["Allowed files", "Deliverables", "Verification", "Commit policy"],
		);
	});

	it("contains exactly the five required sections", () => {
		assert.deepEqual([...REQUIRED_SECTIONS], ["Goal", "Allowed files", "Deliverables", "Verification", "Commit policy"]);
	});

	it("accepts short meaningful sections like 'Commit policy: No commits.'", () => {
		const short = [
			"Goal: Ship the fix.",
			"Allowed files: a.ts.",
			"Deliverables: The fix.",
			"Verification: Tests pass.",
			"Commit policy: No commits.",
		].join("\n");
		assert.deepEqual(findMissingSections(short), []);
	});

	it("never counts the next heading's label as section content", () => {
		const contaminated = [
			"Goal: ......", // punctuation-only body; the next label must not rescue it
			"Allowed files: src/a.ts only, nothing else.",
			"Deliverables: A merged, reviewed change.",
			"Verification: All tests green locally.",
			"Commit policy: No commits.",
		].join("\n");
		assert.deepEqual(findMissingSections(contaminated), ["Goal"]);
	});

	it("does not match label prefixes (Goals:, Goalkeeper)", () => {
		const text = [
			"Goals: ship weekly and keep quality high.", // prefix — not a Goal section
			"Allowed files: src/a.ts only, nothing else.",
			"Deliverables: A merged, reviewed change.",
			"Verification: All tests green locally.",
			"Commit policy: No commits.",
		].join("\n");
		assert.deepEqual(findMissingSections(text), ["Goal"]);
	});
});

describe("validateSend (subagent_send)", () => {
	it("accepts a valid follow-up", () => {
		assert.equal(validateSend({ name: "auth-api", message: GOOD_TASK }), null);
		assert.equal(validateSend({ id: "abc123", message: GOOD_TASK }), null);
	});

	it("requires a target (id or name)", () => {
		assert.match(validateSend({ message: GOOD_TASK })!, /requires 'id' or 'name'/);
	});

	it("validates follow-up message structure", () => {
		const err = validateSend({ name: "auth-api", message: "Goal: continue the work as discussed at length." });
		assert.match(err!, /'message' must contain substantive labelled sections/);
		assert.match(err!, /Missing\/empty: Allowed files, Deliverables, Verification, Commit policy/);
	});
});

describe("decideToolCall — main session, enabled", () => {
	const ctx = { enabled: true, isChild: false };

	it("allows the Herdr orchestration tools", () => {
		for (const tool of ["subagent", "subagent_send", "subagent_stop", "subagent_interrupt", "subagents_list"]) {
			assert.equal(decideToolCall(tool, ctx).action, "allow", tool);
		}
	});

	it("allows bounded read-only and navigation tools", () => {
		for (const tool of ["read", "grep", "find", "fffind", "ffgrep", "lsp_diagnostics", "lsp_definition", "lsp_references", "code_overview", "ask_user_question", "jev"]) {
			assert.equal(decideToolCall(tool, ctx).action, "allow", tool);
		}
	});

	it("blocks shell and file mutation tools", () => {
		for (const tool of ["bash", "powershell", "edit", "write"]) {
			const decision = decideToolCall(tool, ctx);
			assert.equal(decision.action, "block", tool);
			assert.match((decision as any).reason, /not on the main-session allowlist/);
		}
	});

	it("blocks MCP, alternate spawners and unknown/wrapper tools", () => {
		for (const tool of ["mcp", "mcpScript", "agent", "Agent", "subagent_workflow", "SubagentWorkflow", "task", "delegate", "ls", "lsp_rename", "code_rewrite", "totally_unknown_tool"]) {
			assert.equal(decideToolCall(tool, ctx).action, "block", tool);
		}
	});

	it("blocks subagent_resume with fresh-agent advice", () => {
		const decision = decideToolCall("subagent_resume", ctx);
		assert.equal(decision.action, "block");
		assert.match((decision as any).reason, /provenance/);
		assert.match((decision as any).reason, /fresh named agent/);
	});
});

describe("decideToolCall — disabled guard allows everything in main", () => {
	it("allows even bash/edit when disabled", () => {
		const ctx = { enabled: false, isChild: false };
		for (const tool of ["bash", "edit", "write", "mcp", "subagent_resume", "anything_at_all"]) {
			assert.equal(decideToolCall(tool, ctx).action, "allow", tool);
		}
	});
});

describe("decideToolCall — child sessions (PI_SUBAGENT_ID set)", () => {
	const ctx = { enabled: true, isChild: true };

	it("retains execution tools", () => {
		for (const tool of ["bash", "edit", "write", "read", "grep", "powershell"]) {
			assert.equal(decideToolCall(tool, ctx).action, "allow", tool);
		}
	});

	it("does not impose the all-leaf policy: Herdr delegation stays available", () => {
		for (const tool of ["subagent", "subagent_send", "subagents_list"]) {
			assert.equal(decideToolCall(tool, ctx).action, "allow", tool);
		}
	});

	it("rejects known alternate agent tools", () => {
		for (const tool of [...CHILD_DENIED_TOOLS]) {
			assert.equal(decideToolCall(tool, ctx).action, "block", tool);
			assert.equal(decideToolCall(tool.toUpperCase(), ctx).action, "block", tool);
		}
	});

	it("still blocks subagent_resume in children", () => {
		assert.equal(decideToolCall("subagent_resume", ctx).action, "block");
	});
});

describe("allowlist size stays explicit and small", () => {
	it("main allowlist has exactly the agreed tools", () => {
		assert.deepEqual(
			[...MAIN_ALLOWED_TOOLS].sort(),
			[
				"ask_user_question", "code_overview", "fffind", "ffgrep", "find", "grep", "jev",
				"lsp_definition", "lsp_diagnostics", "lsp_hover", "lsp_references", "lsp_symbols",
				"read", "subagent", "subagent_interrupt", "subagent_send", "subagent_stop", "subagents_list",
			].sort(),
		);
	});
});

describe("state persistence", () => {
	it("defaults to enabled when the state file is missing", () => {
		assert.deepEqual(loadState(join(tmpDir, "definitely-missing.json")), { enabled: true });
	});

	it("round-trips on/off and defaults to enabled on corruption", () => {
		const file = join(tmpDir, "state.json");
		saveState(file, false);
		assert.deepEqual(loadState(file), { enabled: false });
		saveState(file, true);
		assert.deepEqual(loadState(file), { enabled: true });
		assert.equal(JSON.parse(readFileSync(file, "utf8")).enabled, true);
		writeFileSync(file, "not json");
		assert.deepEqual(loadState(file), { enabled: true });
	});
});

describe("mocked hook integration (index.ts)", () => {
	it("re-injects the protocol section on EVERY main run, drops it when off, restores when on; enforces tool policy", async () => {
		const { pi, dispatch, commands } = makeMockPi();
		const stateFile = join(tmpDir, "integration-state.json");
		// The test process may itself run inside a Herdr child; force main-session semantics.
		const savedEnv = process.env.PI_SUBAGENT_ID;
		delete process.env.PI_SUBAGENT_ID;
		herdrOrchestratorGuard(pi as any, stateFile);
		assert.equal(loadState(stateFile).enabled, true); // default enabled, file untouched until user toggles

		const mkEvt = () => ({ type: "before_agent_start" as const, prompt: "", systemPromptOptions: { sections: {} as Record<string, string> } });

		// injected on the first run...
		const evt1 = mkEvt();
		dispatch("before_agent_start", evt1);
		assert.match(evt1.systemPromptOptions.sections["herdr_orchestrator_guard"], /subagent_send/);
		assert.match(evt1.systemPromptOptions.sections["herdr_orchestrator_guard"], /Omit 'model'/);
		assert.match(evt1.systemPromptOptions.sections["herdr_orchestrator_guard"], /Commit policy/);
		// ...and STILL on the second run — Pi rebuilds sections per run; a once-flag loses it
		const evt2 = mkEvt();
		dispatch("before_agent_start", evt2);
		assert.match(evt2.systemPromptOptions.sections["herdr_orchestrator_guard"], /Commit policy/);

		// invalid spawn blocked
		const bad = dispatch("tool_call", { type: "tool_call", toolCallId: "1", toolName: "subagent", input: { agent: "worker", name: "bad", task: "no sections here" } });
		assert.equal(bad.block, true);
		assert.match(bad.reason, /'name' must match/);

		// shell blocked in main
		const shell = dispatch("tool_call", { type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "rm -rf /" } });
		assert.equal(shell.block, true);

		// valid spawn passes the hook
		const ok = dispatch("tool_call", { type: "tool_call", toolCallId: "3", toolName: "subagent", input: { agent: "worker", name: "auth-build-1", task: GOOD_TASK } });
		assert.equal(ok, undefined);

		// turn it off via the command — immediate effect on tools AND the prompt section
		const { ctx, notifications } = makeCommandCtx();
		await commands.get("herdr-guard")!.handler("off", ctx);
		assert.match(notifications[0].text, /DISABLED/);
		const evt3 = mkEvt();
		dispatch("before_agent_start", evt3);
		assert.equal(evt3.systemPromptOptions.sections["herdr_orchestrator_guard"], undefined);
		const shell2 = dispatch("tool_call", { type: "tool_call", toolCallId: "4", toolName: "bash", input: { command: "any" } });
		assert.equal(shell2, undefined);
		assert.deepEqual(loadState(stateFile), { enabled: false });

		// and back on — the section returns on the next run
		await commands.get("herdr-guard")!.handler("on", ctx);
		const evt4 = mkEvt();
		dispatch("before_agent_start", evt4);
		assert.match(evt4.systemPromptOptions.sections["herdr_orchestrator_guard"], /subagent_send/);
		assert.equal(dispatch("tool_call", { type: "tool_call", toolCallId: "5", toolName: "bash", input: {} }).block, true);
		assert.deepEqual(loadState(stateFile), { enabled: true });

		// status and usage messages
		await commands.get("herdr-guard")!.handler("status", ctx);
		assert.match(notifications.at(-1)!.text, /ENABLED/);
		await commands.get("herdr-guard")!.handler("bogus", ctx);
		assert.match(notifications.at(-1)!.text, /Usage/);
		if (savedEnv !== undefined) process.env.PI_SUBAGENT_ID = savedEnv;
	});

	it("children keep execution tools but lose alternate agent tools", () => {
		const { pi, dispatch } = makeMockPi();
		herdrOrchestratorGuard(pi as any, join(tmpDir, "child-state.json"));
		const call = (toolName: string, input: any = {}) =>
			dispatch("tool_call", { type: "tool_call", toolCallId: "x", toolName, input });

		process.env.PI_SUBAGENT_ID = "child-1";
		try {
			assert.equal(call("bash", { command: "make test" }), undefined);
			assert.equal(call("edit", { path: "a.ts" }), undefined);
			assert.equal(call("agent").block, true);
			assert.equal(call("SubagentWorkflow").block, true);
			assert.equal(call("task").block, true);
			// herdr delegation stays open for poteto/adversarial-reviewer
			assert.equal(call("subagent", { agent: "worker", name: "auth-test-1", task: GOOD_TASK }), undefined);
			// protocol not injected in children
			const evt = { type: "before_agent_start", prompt: "", systemPromptOptions: { sections: {} as Record<string, string> } };
			dispatch("before_agent_start", evt);
			assert.equal(evt.systemPromptOptions.sections["herdr_orchestrator_guard"], undefined);
		} finally {
			delete process.env.PI_SUBAGENT_ID;
		}
	});

	it("PROTOCOL_SECTION lists the template sections and the omit-model instruction", () => {
		for (const section of REQUIRED_SECTIONS) assert.match(PROTOCOL_SECTION, new RegExp(section));
		assert.match(PROTOCOL_SECTION, /Omit 'model'/);
		assert.match(PROTOCOL_SECTION, /poteto/);
	});
});

after(() => {
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

tmpDir = mkdtempSync(join(tmpdir(), "herdr-guard-test-"));
