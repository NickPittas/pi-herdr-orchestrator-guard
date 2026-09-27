// herdr-orchestrator-guard — global Pi extension guarding Herdr orchestration.
//
// Main sessions (no PI_SUBAGENT_ID): guided to prefer Herdr delegation for
// substantial independent work; ordinary tools (edit/write/bash/read/MCP, and
// unknown general tools) stay available for small direct tasks. Known non-Herdr
// agent tools (agent, SubagentWorkflow, task, delegate) are denied by exact
// case-insensitive tool name, subagent_resume is blocked (provenance cannot be
// proven), and subagent/subagent_send calls are strictly validated.
// Child sessions (PI_SUBAGENT_ID set): keep execution tools; the same non-Herdr
// agent-tool denial applies. Herdr's own spawning controls stay authoritative.
//
// User control: /herdr-guard on|off|status — persisted to state.json next to this file.
// This is policy, not a sandbox: see README.md limitations.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	PROTOCOL_SECTION,
	decideToolCall,
	loadState,
	saveState,
	validateSend,
	validateSpawn,
} from "./policy.ts";

const SECTION_NAME = "herdr_orchestrator_guard";

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
}

export default function herdrOrchestratorGuard(pi: ExtensionAPI, statePathOverride?: string) {
	const statePath =
		statePathOverride ?? join(fileURLToPath(new URL(".", import.meta.url)), "state.json");
	const state = loadState(statePath);

	// Pi REBUILDS systemPromptOptions (including sections) for every run, so the
	// section must be injected/removed on EVERY before_agent_start — a once-flag
	// silently loses it after the first run. Named SECTION only, never a full
	// systemPrompt override. Children carry their own role definition.
	pi.on("before_agent_start", (event) => {
		if (!state.enabled || process.env.PI_SUBAGENT_ID) {
			delete event.systemPromptOptions.sections[SECTION_NAME];
			return;
		}
		event.systemPromptOptions.sections[SECTION_NAME] = PROTOCOL_SECTION;
	});

	pi.on("tool_call", (event) => {
		const isChild = Boolean(process.env.PI_SUBAGENT_ID);
		const decision = decideToolCall(event.toolName, { enabled: state.enabled, isChild });
		if (decision.action === "block") {
			return { block: true, reason: decision.reason };
		}
		if (state.enabled && event.toolName === "subagent") {
			const reason = validateSpawn(event.input);
			if (reason) return { block: true, reason };
		}
		if (state.enabled && event.toolName === "subagent_send") {
			const reason = validateSend(event.input);
			if (reason) return { block: true, reason };
		}
		return undefined;
	});

	pi.registerCommand("herdr-guard", {
		description: "Herdr orchestration guard: /herdr-guard on|off|status",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				state.enabled = arg === "on";
				let persisted = true;
				try {
					saveState(statePath, state.enabled);
				} catch (err) {
					persisted = false;
					notify(
						ctx,
						`herdr-guard: could not persist state (${err instanceof Error ? err.message : String(err)}); active for this session only.`,
						"warning",
					);
				}
				if (persisted) {
					notify(ctx, `herdr-guard ${state.enabled ? "ENABLED" : "DISABLED"} (saved to ${statePath}).`);
				}
			} else if (arg === "" || arg === "status") {
				notify(
					ctx,
					`herdr-guard is ${state.enabled ? "ENABLED" : "DISABLED"} (default: enabled). ` +
						"Known non-Herdr agent tools (agent, SubagentWorkflow, task, delegate) are blocked by name; " +
						"Herdr subagent calls are validated. Usage: /herdr-guard on|off|status.",
				);
			} else {
				notify(ctx, "Usage: /herdr-guard on|off|status", "warning");
			}
		},
	});
}
