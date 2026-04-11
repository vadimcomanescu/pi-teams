/**
 * SendMessage Tool
 *
 * Lets the coordinator send follow-up messages to running worker agents via
 * their RPC stdin pipe. If a teammate already finished and has a resumable
 * session, send_message can continue that teammate by spawning a fresh RPC run
 * with the same identity and queueing the new message as the next user turn.
 */

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { AgentRegistry, RegisteredAgent } from "./agent-registry.js";
import { describeTeammateLifecycle } from "./teammate-lifecycle.js";
import type { ResumeAgentFn } from "./teammate-continuation.js";
import type { TeamManager } from "./team-manager.js";
import type { TeammateControlMessage } from "./types.js";

const ShutdownRequestMessage = Type.Object({
	type: Type.Literal("shutdown_request"),
});

const ShutdownResponseMessage = Type.Object({
	type: Type.Literal("shutdown_response"),
	request_id: Type.String({ description: "Shutdown request ID" }),
	approve: Type.Boolean({ description: "Whether the teammate approves the shutdown request" }),
	reason: Type.Optional(Type.String({ description: "Required when approve=false" })),
});

export const SendMessageParams = Type.Object({
	to: Type.String({ description: "Agent name or ID to send message to" }),
	summary: Type.Optional(Type.String({ description: "Required when message is plain text" })),
	message: Type.Union([
		Type.String({ description: "Plain-text follow-up message" }),
		ShutdownRequestMessage,
		ShutdownResponseMessage,
	]),
});

interface ShutdownRequestPayload {
	type: "shutdown_request";
}

interface ShutdownResponsePayload {
	type: "shutdown_response";
	request_id: string;
	approve: boolean;
	reason?: string;
}

type StructuredSendMessagePayload = ShutdownRequestPayload | ShutdownResponsePayload;
type SendMessagePayload = string | StructuredSendMessagePayload;

export interface SendMessageDetails {
	to: string;
	delivered: "queued" | "resumed" | "handled" | "failed" | "error";
	agent_id?: string;
	message_type?: "plain_text" | "shutdown_request" | "shutdown_response";
	request_id?: string;
	approved?: boolean;
}

interface SendMessageToolOptions {
	resumeAgent?: ResumeAgentFn;
	teamManager?: TeamManager;
	runtimeRole?: "lead" | "teammate" | "raw-worker";
	emitControlMessage?: (message: TeammateControlMessage) => void;
}

function toResult(
	text: string,
	details: SendMessageDetails,
	isError?: boolean,
) {
	return {
		content: [{ type: "text" as const, text }],
		isError,
		details,
	};
}

function isBroadcastTarget(target: string): boolean {
	const normalized = target.trim().toLowerCase();
	return normalized === "*" || normalized === "all" || normalized.includes(",");
}

function formatShutdownRequestPrompt(input: { requestId: string; summary?: string }): string {
	const summaryLine = input.summary?.trim()
		? `Summary: ${input.summary.trim()}`
		: "Summary: Gracefully stop when safe.";
	return [
		"The lead is requesting a graceful shutdown.",
		`Request ID: ${input.requestId}`,
		summaryLine,
		"If you can stop now, respond with:",
		`send_message({ to: \"lead\", message: { type: \"shutdown_response\", request_id: \"${input.requestId}\", approve: true } })`,
		"If you cannot stop yet, respond with:",
		`send_message({ to: \"lead\", message: { type: \"shutdown_response\", request_id: \"${input.requestId}\", approve: false, reason: \"<why you need to keep running>\" } })`,
		"A rejection must include a reason.",
	].join("\n");
}

function emitTeammateControlMessage(message: TeammateControlMessage): void {
	process.stdout.write(`${JSON.stringify({ type: "teammate_control_message", message })}\n`);
}

function renderMessagePreview(message: SendMessagePayload, summary?: string): string {
	if (typeof message === "string") {
		const preview = summary?.trim() || message;
		return preview.includes("\n") ? preview.slice(0, preview.indexOf("\n")) : preview;
	}
	if (message.type === "shutdown_request") {
		return summary?.trim() ? `shutdown_request: ${summary.trim()}` : "shutdown_request";
	}
	if (message.approve) {
		return `shutdown_response approve (${message.request_id})`;
	}
	return `shutdown_response reject (${message.request_id})`;
}

export function createSendMessageTool(
	registry: AgentRegistry,
	options: SendMessageToolOptions = {},
): ToolDefinition<typeof SendMessageParams, SendMessageDetails> {
	const runtimeRole = options.runtimeRole ?? "lead";
	const emitControlMessage = options.emitControlMessage ?? emitTeammateControlMessage;

	const resolveAgent = (target: string) => {
		const agent = registry.resolve(target);
		if (agent) return { agent };
		const available = registry.getNames();
		const list = available.length > 0 ? available.join(", ") : "(none)";
		return {
			error: toResult(
				`Agent not found: "${target}". Available agents: ${list}`,
				{ to: target, delivered: "error" },
				true,
			),
		};
	};

	const queueFollowUp = (agent: RegisteredAgent, label: string, message: string, details: SendMessageDetails) => {
		try {
			agent.rpcHandle!.stdin.write(
				JSON.stringify({ type: "follow_up", message }) + "\n",
			);
		} catch {
			return toResult(
				"Failed to deliver message: worker stdin closed",
				{ ...details, to: label, delivered: "failed" },
				true,
			);
		}

		return toResult(
			details.message_type === "shutdown_request"
				? `Graceful shutdown requested from "${label}"`
				: `Message queued for "${label}"`,
			{ ...details, to: label, delivered: "queued", agent_id: agent.id },
		);
	};

	const handlePlainTextMessage = async (
		target: string,
		message: string,
		summary: string | undefined,
		signal: AbortSignal | undefined,
		ctx: unknown,
	) => {
		const trimmedSummary = summary?.trim();
		if (!trimmedSummary) {
			return toResult(
				"Plain-text send_message requires a non-empty summary.",
				{ to: target, delivered: "error", message_type: "plain_text" },
				true,
			);
		}
		const trimmedMessage = message.trim();
		if (!trimmedMessage) {
			return toResult(
				"Message content cannot be empty.",
				{ to: target, delivered: "error", message_type: "plain_text" },
				true,
			);
		}
		const resolved = resolveAgent(target);
		if (resolved.error) return resolved.error;
		const agent = resolved.agent!;
		const label = agent.name ?? agent.id;
		const lifecycle = describeTeammateLifecycle({
			status: agent.status,
			sessionFile: agent.sessionFile,
			acceptsFollowUps: Boolean(agent.rpcHandle),
		});

		if (lifecycle.canQueueFollowUp) {
			return queueFollowUp(agent, label, trimmedMessage, {
				to: label,
				delivered: "queued",
				message_type: "plain_text",
			});
		}

		if (!lifecycle.canResume) {
			const reason = agent.status === "running"
				? lifecycle.continuationText
				: agent.sessionFile
					? lifecycle.continuationText
					: "has no resumable session. Spawn a fresh teammate if you need to continue this work";
			return toResult(
				`Agent "${label}": ${reason}.`,
				{ to: label, delivered: "error", message_type: "plain_text" },
				true,
			);
		}

		if (!options.resumeAgent) {
			return toResult(
				`Agent "${label}" is resumable, but this session cannot resume it.`,
				{ to: label, delivered: "error", message_type: "plain_text" },
				true,
			);
		}

		try {
			const resumed = await options.resumeAgent(agent, trimmedMessage, signal, ctx);
			return toResult(
				`Resumed "${label}" and queued the follow-up message`,
				{ to: label, delivered: "resumed", agent_id: resumed.agentId, message_type: "plain_text" },
			);
		} catch (error) {
			return toResult(
				`Failed to resume "${label}": ${error instanceof Error ? error.message : String(error)}`,
				{ to: label, delivered: "error", message_type: "plain_text" },
				true,
			);
		}
	};

	const handleShutdownRequest = (target: string, summary: string | undefined) => {
		if (runtimeRole !== "lead") {
			return toResult(
				"shutdown_request may only originate from the lead session.",
				{ to: target, delivered: "error", message_type: "shutdown_request" },
				true,
			);
		}
		if (isBroadcastTarget(target)) {
			return toResult(
				"Structured shutdown messages cannot be broadcast.",
				{ to: target, delivered: "error", message_type: "shutdown_request" },
				true,
			);
		}
		const resolved = resolveAgent(target);
		if (resolved.error) return resolved.error;
		const agent = resolved.agent!;
		const label = agent.name ?? agent.id;
		if (agent.runtimeRole !== "teammate" || !agent.teamMetadata?.teamName) {
			return toResult(
				`Agent "${label}" is not a named teammate and cannot participate in graceful shutdown approval.`,
				{ to: label, delivered: "error", message_type: "shutdown_request" },
				true,
			);
		}
		const lifecycle = describeTeammateLifecycle({
			status: agent.status,
			sessionFile: agent.sessionFile,
			acceptsFollowUps: Boolean(agent.rpcHandle),
		});
		if (!lifecycle.canQueueFollowUp) {
			return toResult(
				`Agent "${label}": ${lifecycle.continuationText}.`,
				{ to: label, delivered: "error", message_type: "shutdown_request" },
				true,
			);
		}

		const requestId = randomUUID();
		const queued = queueFollowUp(agent, label, formatShutdownRequestPrompt({ requestId, summary }), {
			to: label,
			delivered: "queued",
			message_type: "shutdown_request",
			request_id: requestId,
		});
		if (queued.isError) {
			options.teamManager?.clearPendingShutdownRequest(agent.id, requestId);
			return queued;
		}
		try {
			options.teamManager?.recordShutdownRequest(agent.id, requestId, summary);
			return queued;
		} catch (error) {
			options.teamManager?.clearPendingShutdownRequest(agent.id, requestId);
			return toResult(
				error instanceof Error ? error.message : String(error),
				{ to: label, delivered: "error", message_type: "shutdown_request", request_id: requestId },
				true,
			);
		}
	};

	const handleShutdownResponse = (target: string, payload: ShutdownResponsePayload, _summary: string | undefined) => {
		if (runtimeRole !== "teammate") {
			return toResult(
				"shutdown_response may only originate from a teammate runtime.",
				{ to: target, delivered: "error", message_type: "shutdown_response", request_id: payload.request_id, approved: payload.approve },
				true,
			);
		}
		if (isBroadcastTarget(target)) {
			return toResult(
				"Structured shutdown messages cannot be broadcast.",
				{ to: target, delivered: "error", message_type: "shutdown_response", request_id: payload.request_id, approved: payload.approve },
				true,
			);
		}
		if (target.trim().toLowerCase() !== "lead") {
			return toResult(
				"shutdown_response must target the lead.",
				{ to: target, delivered: "error", message_type: "shutdown_response", request_id: payload.request_id, approved: payload.approve },
				true,
			);
		}
		const requestId = payload.request_id.trim();
		if (!requestId) {
			return toResult(
				"shutdown_response requires a non-empty request_id.",
				{ to: target, delivered: "error", message_type: "shutdown_response", approved: payload.approve },
				true,
			);
		}
		const reason = payload.reason?.trim();
		if (!payload.approve && !reason) {
			return toResult(
				"Rejected shutdown_response requires a non-empty reason.",
				{ to: target, delivered: "error", message_type: "shutdown_response", request_id: requestId, approved: false },
				true,
			);
		}
		if (!options.teamManager) {
			return toResult(
				"shutdown_response is unavailable because team state is not configured in this runtime.",
				{ to: target, delivered: "error", message_type: "shutdown_response", request_id: requestId, approved: payload.approve },
				true,
			);
		}

		try {
			options.teamManager.validateCurrentTeammateShutdownRequest(requestId);
			emitControlMessage({
				type: "shutdown_response",
				requestId,
				approve: payload.approve,
				reason,
			});
			return toResult(
				payload.approve
					? "Sent graceful shutdown approval to the lead."
					: `Sent graceful shutdown rejection to the lead: ${reason}`,
				{ to: "lead", delivered: "handled", message_type: "shutdown_response", request_id: requestId, approved: payload.approve },
			);
		} catch (error) {
			return toResult(
				error instanceof Error ? error.message : String(error),
				{ to: target, delivered: "error", message_type: "shutdown_response", request_id: requestId, approved: payload.approve },
				true,
			);
		}
	};

	return {
		name: "send_message",
		label: "Send Message",
		description: "Send a follow-up message to a worker, or resume an addressable teammate when useful",
		parameters: SendMessageParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const target = params.to.trim();
			if (!target) {
				return toResult("Target cannot be empty.", { to: params.to, delivered: "error" }, true);
			}
			const payload = params.message as SendMessagePayload;
			if (typeof payload === "string") {
				return handlePlainTextMessage(target, payload, params.summary, signal, ctx);
			}
			if (payload.type === "shutdown_request") {
				return handleShutdownRequest(target, params.summary);
			}
			return handleShutdownResponse(target, payload, params.summary);
		},

		renderCall(args, theme) {
			const header = `${theme.fg("toolTitle", theme.bold("send_message "))}@${args.to ?? ""}`;
			const indent = "  ";
			const preview = renderMessagePreview(args.message as SendMessagePayload, args.summary);
			const truncated = preview.length > 120 ? preview.slice(0, 117) + "…" : preview;
			return new Text(`${header}\n${indent}${truncated}`, 0, 0);
		},
	};
}
