/**
 * SendMessage Tool
 *
 * Lets the coordinator send follow-up messages to running worker agents via
 * their RPC stdin pipe. Background-mode agents (no rpcHandle) and completed
 * agents return descriptive errors so the coordinator can act accordingly.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { AgentRegistry } from "./agent-registry.js";

// =============================================================================
// Schema
// =============================================================================

export const SendMessageParams = Type.Object({
	to: Type.String({ description: "Agent name or ID to send message to" }),
	message: Type.String({ description: "Message content to send to the agent" }),
});

// =============================================================================
// Details type
// =============================================================================

export interface SendMessageDetails {
	to: string;
	delivered: "queued" | "failed" | "error";
}

// =============================================================================
// Tool factory
// =============================================================================

/**
 * Create a send_message tool bound to the given agent registry.
 *
 * The tool routes a follow-up message to a running RPC-mode agent by writing
 * a JSON line to its stdin pipe.  It returns descriptive errors for bg-mode
 * agents, completed agents, and unknown names/IDs.
 */
export function createSendMessageTool(
	registry: AgentRegistry,
): ToolDefinition<typeof SendMessageParams, SendMessageDetails> {
	return {
		name: "send_message",
		label: "Send Message",
		description: "Send a follow-up message to a running worker agent",
		parameters: SendMessageParams,

		async execute(_toolCallId, params) {
			const agent = registry.resolve(params.to);

			// ── Unknown agent ────────────────────────────────────────────────
			if (!agent) {
				const available = registry.getNames();
				const list = available.length > 0 ? available.join(", ") : "(none)";
				return {
					content: [
						{
							type: "text" as const,
							text: `Agent not found: "${params.to}". Available agents: ${list}`,
						},
					],
					isError: true,
					details: { to: params.to, delivered: "error" as const },
				};
			}

			// ── Agent is not running ─────────────────────────────────────────
			if (agent.status !== "running") {
				const label = agent.name ?? agent.id;
				return {
					content: [
						{
							type: "text" as const,
							text: `Agent "${label}" is not running (status: ${agent.status}). To continue a completed agent, spawn a new worker with the context you need.`,
						},
					],
					isError: true,
					details: { to: label, delivered: "error" as const },
				};
			}

			// ── Running, background mode (no rpcHandle) ──────────────────────
			if (!agent.rpcHandle) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Agent was spawned in background mode and does not accept follow-up messages.",
						},
					],
					isError: true,
					details: { to: agent.name ?? agent.id, delivered: "error" as const },
				};
			}

			// ── Running RPC agent ────────────────────────────────────────────
			const label = agent.name ?? agent.id;
			try {
				agent.rpcHandle.stdin.write(
					JSON.stringify({ type: "follow_up", message: params.message }) + "\n",
				);
			} catch {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to deliver message: worker stdin closed`,
						},
					],
					isError: true,
					details: { to: label, delivered: "failed" as const },
				};
			}

			return {
				content: [{ type: "text" as const, text: `Message queued for "${label}"` }],
				details: { to: label, delivered: "queued" as const },
			};
		},

		renderCall(args, theme) {
			const header = `${theme.fg("toolTitle", theme.bold("send_message "))}@${args.to ?? ""}`;
			const indent = "  ";
			const msg = args.message ?? "";
			// Trim long messages for display — first line only, 120 chars
			const preview = msg.includes("\n") ? msg.slice(0, msg.indexOf("\n")) : msg;
			const truncated = preview.length > 120 ? preview.slice(0, 117) + "…" : preview;
			return new Text(`${header}\n${indent}${truncated}`, 0, 0);
		},
	};
}
