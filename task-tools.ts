import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { TeamManager } from "./team-manager.js";
import { TaskStore, type TeamTaskStatus } from "./task-store.js";

const TaskStatusSchema = Type.String({
	enum: ["pending", "in_progress", "completed", "deleted"],
});

export const TaskCreateParams = Type.Object({
	team_name: Type.Optional(Type.String()),
	subject: Type.String(),
	description: Type.String(),
});

export const TaskListParams = Type.Object({
	team_name: Type.Optional(Type.String()),
});

export const TaskReadParams = Type.Object({
	team_name: Type.Optional(Type.String()),
	task_id: Type.String(),
});

export const TaskUpdateParams = Type.Object({
	team_name: Type.Optional(Type.String()),
	task_id: Type.String(),
	status: Type.Optional(TaskStatusSchema),
	owner: Type.Optional(Type.String()),
});

interface TaskToolsDeps {
	teamManager: TeamManager;
	createTaskStore: (teamName: string) => TaskStore;
}

function toErrorResult(message: string, details?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
		details,
	};
}

function formatTask(task: { id: string; subject: string; status: string; owner?: string }): string {
	return `${task.id} [${task.status}] ${task.subject}${task.owner ? ` (owner: ${task.owner})` : ""}`;
}

export function createTaskCreateTool(deps: TaskToolsDeps): ToolDefinition<typeof TaskCreateParams> {
	return {
		name: "task_create",
		label: "Task Create",
		description: "Create a shared task for a team",
		parameters: TaskCreateParams,
		async execute(_toolCallId, params) {
			try {
				const team = deps.teamManager.assertLeadControl(params.team_name);
				const task = deps.createTaskStore(team.name).createTask(params.subject, params.description);
				return {
					content: [{ type: "text" as const, text: `Created task ${task.id}: ${task.subject}` }],
					details: { ...task, team_name: team.name },
				};
			} catch (error) {
				return toErrorResult(error instanceof Error ? error.message : String(error), { team_name: params.team_name });
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("task_create "))}${args.team_name ?? "(current team)"}`, 0, 0);
		},
	};
}

export function createTaskListTool(deps: TaskToolsDeps): ToolDefinition<typeof TaskListParams> {
	return {
		name: "task_list",
		label: "Task List",
		description: "List a team's shared tasks",
		parameters: TaskListParams,
		async execute(_toolCallId, params) {
			try {
				const team = deps.teamManager.assertTeamAccess(params.team_name);
				const tasks = deps.createTaskStore(team.name).listTasks();
				return {
					content: [{ type: "text" as const, text: tasks.length > 0 ? tasks.map(formatTask).join("\n") : `No tasks for team "${team.name}"` }],
					details: { team_name: team.name, tasks },
				};
			} catch (error) {
				return toErrorResult(error instanceof Error ? error.message : String(error), { team_name: params.team_name });
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("task_list "))}${args.team_name ?? "(current team)"}`, 0, 0);
		},
	};
}

export function createTaskReadTool(deps: TaskToolsDeps): ToolDefinition<typeof TaskReadParams> {
	return {
		name: "task_read",
		label: "Task Read",
		description: "Read one shared team task",
		parameters: TaskReadParams,
		async execute(_toolCallId, params) {
			try {
				const team = deps.teamManager.assertTeamAccess(params.team_name);
				const task = deps.createTaskStore(team.name).readTask(params.task_id);
				if (!task) {
					return toErrorResult(`Task not found: ${params.task_id}`, { team_name: team.name, task_id: params.task_id });
				}
				return {
					content: [{
						type: "text" as const,
						text: [
							`Task: ${task.id}`,
							`Subject: ${task.subject}`,
							`Status: ${task.status}`,
							task.owner ? `Owner: ${task.owner}` : undefined,
							"",
							task.description,
						].filter(Boolean).join("\n"),
					}],
					details: { ...task, team_name: team.name },
				};
			} catch (error) {
				return toErrorResult(error instanceof Error ? error.message : String(error), { team_name: params.team_name, task_id: params.task_id });
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("task_read "))}${args.task_id}@${args.team_name ?? "(current team)"}`, 0, 0);
		},
	};
}

export function createTaskUpdateTool(deps: TaskToolsDeps): ToolDefinition<typeof TaskUpdateParams> {
	return {
		name: "task_update",
		label: "Task Update",
		description: "Update task ownership or status",
		parameters: TaskUpdateParams,
		async execute(_toolCallId, params) {
			try {
				const team = deps.teamManager.assertLeadControl(params.team_name);
				const store = deps.createTaskStore(team.name);
				const existing = store.readTask(params.task_id);
				if (!existing) {
					return toErrorResult(`Task not found: ${params.task_id}`, { team_name: team.name, task_id: params.task_id });
				}
				if (params.status === undefined && params.owner === undefined) {
					return toErrorResult("Provide status and/or owner to update.", { team_name: team.name, task_id: params.task_id });
				}
				const updated = store.updateTask(
					params.task_id,
					{ status: params.status as TeamTaskStatus | undefined, owner: params.owner },
					existing.version,
				);
				return {
					content: [{ type: "text" as const, text: `Updated task ${updated.id}` }],
					details: { ...updated, team_name: team.name },
				};
			} catch (error) {
				return toErrorResult(error instanceof Error ? error.message : String(error), { team_name: params.team_name, task_id: params.task_id });
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("task_update "))}${args.task_id}@${args.team_name ?? "(current team)"}`, 0, 0);
		},
	};
}
