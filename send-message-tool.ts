/**
 * SendMessage Tool
 *
 * Lets the coordinator send follow-up messages to running worker agents via
 * their RPC stdin pipe. If a teammate already finished and has a resumable
 * session, send_message can continue that teammate by spawning a fresh RPC run
 * with the same identity and queueing the new message as the next user turn.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { AgentRegistry, RegisteredAgent } from "./agent-registry.js";
import { describeTeammateLifecycle } from "./teammate-lifecycle.js";
import type { ResumeAgentFn } from "./teammate-continuation.js";

export const SendMessageParams = Type.Object({
	to: Type.String({ description: "Agent name or ID to send message to" }),
	message: Type.String({ description: "Message content to send to the agent" }),
});

export interface SendMessageDetails {
	to: string;
	delivered: "queued" | "resumed" | "failed" | "error";
	agent_id?: string;
}

interface SendMessageToolOptions {
	resumeAgent?: ResumeAgentFn;
}

export function createSendMessageTool(
	registry: AgentRegistry,
	options: SendMessageToolOptions = {},
): ToolDefinition<typeof SendMessageParams, SendMessageDetails> {
	return {
		name: "send_message",
		label: "Send Message",
		description: "Send a follow-up message to a worker, or resume an addressable teammate when useful",
		parameters: SendMessageParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const agent = registry.resolve(params.to);
			const trimmedMessage = params.message.trim();
			if (!trimmedMessage) {
				return {
					content: [{ type: "text" as const, text: "Message content cannot be empty." }],
					isError: true,
					details: { to: params.to, delivered: "error" as const },
				};
			}
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

			const label = agent.name ?? agent.id;
			const lifecycle = describeTeammateLifecycle({
				status: agent.status,
				sessionFile: agent.sessionFile,
				acceptsFollowUps: Boolean(agent.rpcHandle),
			});

			if (lifecycle.canQueueFollowUp) {
				try {
					agent.rpcHandle!.stdin.write(
						JSON.stringify({ type: "follow_up", message: trimmedMessage }) + "\n",
					);
				} catch {
					return {
						content: [
							{
								type: "text" as const,
								text: "Failed to deliver message: worker stdin closed",
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
			}

			if (!lifecycle.canResume) {
				const reason = agent.status === "running"
					? lifecycle.continuationText
					: agent.sessionFile
						? lifecycle.continuationText
						: "has no resumable session. Spawn a fresh teammate if you need to continue this work";
				return {
					content: [{ type: "text" as const, text: `Agent "${label}": ${reason}.` }],
					isError: true,
					details: { to: label, delivered: "error" as const },
				};
			}

			if (!options.resumeAgent) {
				return {
					content: [{ type: "text" as const, text: `Agent "${label}" is resumable, but this session cannot resume it.` }],
					isError: true,
					details: { to: label, delivered: "error" as const },
				};
			}

			try {
				const resumed = await options.resumeAgent(agent, trimmedMessage, signal, ctx);
				return {
					content: [{ type: "text" as const, text: `Resumed "${label}" and queued the follow-up message` }],
					details: { to: label, delivered: "resumed" as const, agent_id: resumed.agentId },
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to resume "${label}": ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
					details: { to: label, delivered: "error" as const },
				};
			}
		},

		renderCall(args, theme) {
			const header = `${theme.fg("toolTitle", theme.bold("send_message "))}@${args.to ?? ""}`;
			const indent = "  ";
			const msg = args.message ?? "";
			const preview = msg.includes("\n") ? msg.slice(0, msg.indexOf("\n")) : msg;
			const truncated = preview.length > 120 ? preview.slice(0, 117) + "…" : preview;
			return new Text(`${header}\n${indent}${truncated}`, 0, 0);
		},
	};
}
