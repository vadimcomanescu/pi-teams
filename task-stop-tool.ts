/**
 * Task Stop Tool
 *
 * Lets the coordinator stop a running worker agent by name or ID.
 * Only available in coordinator mode.
 */

import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentRegistry } from "./agent-registry.js";

// =============================================================================
// Schema
// =============================================================================

export const TaskStopParams = Type.Object({
	task_id: Type.String({ description: "Agent name or ID to stop" }),
	reason: Type.Optional(
		Type.String({ description: "Why stopping (logged, not sent to agent)" }),
	),
});

// =============================================================================
// Tool factory
// =============================================================================

export function createTaskStopTool(
	registry: AgentRegistry,
	onStopped?: (agent: { id: string; agent: string; name?: string; status: "stopped"; summary: string }) => void,
): ToolDefinition<typeof TaskStopParams> {
	return {
		name: "task_stop",
		label: "Task Stop",
		description: "Stop a running worker agent",
		parameters: TaskStopParams,

		async execute(_id, params) {
			const { task_id, reason } = params;
			const agent = registry.resolve(task_id);

			if (!agent) {
				const names = registry.getNames();
				const list =
					names.length > 0
						? `Available agents: ${names.join(", ")}`
						: "No agents are currently registered.";
				return {
					content: [{ type: "text", text: `Agent "${task_id}" not found. ${list}` }],
					isError: true,
					details: { task_id },
				};
			}

			if (agent.status !== "running") {
				return {
					content: [
						{
							type: "text",
							text: `Agent is not running (status: ${agent.status})`,
						},
					],
					isError: true,
					details: { task_id: params.task_id },
				};
			}

			const displayName = agent.name ?? agent.id;
			registry.stopAgent(agent.id);
			onStopped?.({
				id: agent.id,
				agent: agent.agentType,
				name: agent.name,
				status: "stopped",
				summary: reason ? `Stopped by lead: ${reason}` : "Stopped by lead",
			});
			return {
				content: [
					{
						type: "text",
						text: `Stopped agent "${displayName}"${reason ? `: ${reason}` : ""}`,
					},
				],
				details: {
					task_id: agent.id,
					agent: agent.agentType,
					name: agent.name,
					status: "stopped",
				},
			};
		},

		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("task_stop "))}@${args.task_id}`,
				0,
				0,
			);
		},
	};
}
