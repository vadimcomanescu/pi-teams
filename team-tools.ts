import { Type } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { TeamManager } from "./team-manager.js";
import type { TeamTask } from "./task-store.js";

export const TeamCreateParams = Type.Object({
	team_name: Type.String(),
	description: Type.Optional(Type.String()),
	default_model: Type.Optional(Type.String()),
});

export const SpawnTeammateParams = Type.Object({
	team_name: Type.String(),
	name: Type.String(),
	prompt: Type.String(),
	cwd: Type.String(),
	model: Type.Optional(Type.String()),
});

export const CheckTeammateParams = Type.Object({
	team_name: Type.String(),
	agent_name: Type.String(),
});

export const TeamShutdownParams = Type.Object({
	team_name: Type.String(),
});

interface SpawnTeammateRequest {
	teamName: string;
	name: string;
	prompt: string;
	cwd: string;
	effectiveModel?: string;
	teammateNames: string[];
	assignedTaskIds: string[];
	configPath: string;
	tasksPath: string;
}

interface SpawnTeammateOutcome {
	agentId: string;
	effectiveModel?: string;
}

interface TeamToolsDeps {
	teamManager: TeamManager;
	listAssignedTasks: (teamName: string, teammateName: string) => TeamTask[];
	spawnTeammate: (request: SpawnTeammateRequest, ctx: ExtensionContext, signal: AbortSignal) => Promise<SpawnTeammateOutcome>;
}

function toErrorResult(message: string, details?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
		details,
	};
}

export function createTeamCreateTool(
	teamManager: TeamManager,
): ToolDefinition<typeof TeamCreateParams> {
	return {
		name: "team_create",
		label: "Team Create",
		description: "Create a team for the current lead session",
		parameters: TeamCreateParams,
		async execute(_toolCallId, params) {
			try {
				const team = teamManager.createTeam(params);
				return {
					content: [{ type: "text" as const, text: `Created team "${team.name}"` }],
					details: {
						team_name: team.name,
						state: team.state,
						default_model: team.defaultModel,
					},
				};
			} catch (error) {
				return toErrorResult(error instanceof Error ? error.message : String(error), { team_name: params.team_name });
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("team_create "))}${args.team_name}`, 0, 0);
		},
	};
}

export function createSpawnTeammateTool(
	deps: TeamToolsDeps,
): ToolDefinition<typeof SpawnTeammateParams> {
	return {
		name: "spawn_teammate",
		label: "Spawn Teammate",
		description: "Spawn a named RPC teammate inside an active team",
		parameters: SpawnTeammateParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const team = deps.teamManager.assertLeadControl(params.team_name);
				if (team.state !== "active") {
					return toErrorResult(`Team "${team.name}" is not active.`, { team_name: team.name, name: params.name });
				}

				const assignedTaskIds = deps.listAssignedTasks(team.name, params.name)
					.filter((task) => task.status !== "deleted")
					.map((task) => task.id);
				const teammateNames = team.members.map((member) => member.name);
				const effectiveModel = params.model ?? team.defaultModel;

				const spawned = await deps.spawnTeammate({
					teamName: team.name,
					name: params.name,
					prompt: params.prompt,
					cwd: params.cwd,
					effectiveModel,
					teammateNames,
					assignedTaskIds,
					configPath: deps.teamManager.getConfigPath(team.name),
					tasksPath: deps.teamManager.getTasksPath(team.name),
				}, ctx, signal ?? new AbortController().signal);

				deps.teamManager.registerTeammate(team.name, {
					name: params.name,
					agentId: spawned.agentId,
					agentType: "worker",
					model: spawned.effectiveModel,
					status: "running",
					cwd: params.cwd,
				});

				return {
					content: [{ type: "text" as const, text: `Spawned teammate "${params.name}" in team "${team.name}"` }],
					details: {
						team_name: team.name,
						name: params.name,
						agent_id: spawned.agentId,
						model: spawned.effectiveModel,
					},
				};
			} catch (error) {
				return toErrorResult(error instanceof Error ? error.message : String(error), { team_name: params.team_name, name: params.name });
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("spawn_teammate "))}${args.name}@${args.team_name}`, 0, 0);
		},
	};
}

export function createCheckTeammateTool(
	teamManager: TeamManager,
): ToolDefinition<typeof CheckTeammateParams> {
	return {
		name: "check_teammate",
		label: "Check Teammate",
		description: "Inspect a teammate's current status",
		parameters: CheckTeammateParams,
		async execute(_toolCallId, params) {
			try {
				const status = teamManager.checkTeammate(params.team_name, params.agent_name);
				return {
					content: [
						{
							type: "text" as const,
							text: [
								`Team: ${status.teamName}`,
								`Teammate: ${status.member.name}`,
								`Status: ${status.status}`,
								status.effectiveModel ? `Model: ${status.effectiveModel}` : undefined,
								status.lastSummary ? `Summary: ${status.lastSummary}` : undefined,
							].filter(Boolean).join("\n"),
						},
					],
					details: {
						team_name: status.teamName,
						name: status.member.name,
						status: status.status,
						model: status.effectiveModel,
						lastSummary: status.lastSummary,
						state: status.state,
					},
				};
			} catch (error) {
				return toErrorResult(error instanceof Error ? error.message : String(error), { team_name: params.team_name, name: params.agent_name });
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("check_teammate "))}${args.agent_name}@${args.team_name}`, 0, 0);
		},
	};
}

export function createTeamShutdownTool(
	teamManager: TeamManager,
): ToolDefinition<typeof TeamShutdownParams> {
	return {
		name: "team_shutdown",
		label: "Team Shutdown",
		description: "Stop all teammates in a team and mark it shutdown",
		parameters: TeamShutdownParams,
		async execute(_toolCallId, params) {
			try {
				const team = teamManager.shutdownTeam(params.team_name, "Stopped by lead session");
				return {
					content: [{ type: "text" as const, text: `Shut down team "${team.name}"` }],
					details: {
						team_name: team.name,
						state: team.state,
						members: team.members.map((member) => ({ name: member.name, status: member.status })),
					},
				};
			} catch (error) {
				return toErrorResult(error instanceof Error ? error.message : String(error), { team_name: params.team_name });
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("team_shutdown "))}${args.team_name}`, 0, 0);
		},
	};
}
