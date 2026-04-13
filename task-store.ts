import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { withFileLock, writeJsonAtomically } from "./state-file-utils.js";

export type TeamTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TeamTask {
	id: string;
	subject: string;
	description: string;
	status: TeamTaskStatus;
	owner?: string;
	dependsOn: string[];
	blocked?: boolean;
	createdAt: number;
	updatedAt: number;
	version: number;
}

export interface UnassignTasksForOwnerResult {
	unassignedTasks: Array<{ id: string; subject: string }>;
}

export interface UnassignTasksForOwnerOptions {
	aliases?: string[];
}

interface TaskFile {
	schemaVersion: 1;
	tasks: TeamTask[];
}

export class TaskStoreVersionError extends Error {}

function defaultTaskFile(): TaskFile {
	return { schemaVersion: 1, tasks: [] };
}

export class TaskStore {
	private readonly teamName: string;
	private readonly tasksPath: string;

	constructor(teamName: string, tasksPath: string) {
		this.teamName = teamName;
		this.tasksPath = tasksPath;
	}

	private readFile(): TaskFile {
		if (!fs.existsSync(this.tasksPath)) {
			return defaultTaskFile();
		}
		try {
			const parsed = JSON.parse(fs.readFileSync(this.tasksPath, "utf-8")) as Partial<TaskFile>;
			const schemaVersion = parsed.schemaVersion;
			if (schemaVersion !== 1 || !Array.isArray(parsed.tasks)) {
				throw new Error("tasks.json must contain { schemaVersion: 1, tasks: [] }");
			}
			return {
				schemaVersion: 1,
				tasks: parsed.tasks.map((task) => ({
					id: task.id,
					subject: task.subject,
					description: task.description,
					status: task.status,
					owner: task.owner,
					dependsOn: Array.isArray(task.dependsOn)
						? task.dependsOn.filter((entry): entry is string => typeof entry === "string")
						: [],
					createdAt: task.createdAt,
					updatedAt: task.updatedAt,
					version: task.version,
				})),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Corrupt tasks.json for team "${this.teamName}": ${message}`);
		}
	}

	private writeFile(file: TaskFile): void {
		writeJsonAtomically(this.tasksPath, file);
	}

	private withWriteLock<T>(callback: () => T): T {
		return withFileLock(this.tasksPath, callback);
	}

	private computeBlocked(file: TaskFile, task: TeamTask): boolean {
		if (task.dependsOn.length === 0) return false;
		for (const dependencyId of task.dependsOn) {
			const prerequisite = file.tasks.find((entry) => entry.id === dependencyId);
			if (!prerequisite || prerequisite.status !== "completed") {
				return true;
			}
		}
		return false;
	}

	private withBlockedState(file: TaskFile, task: TeamTask): TeamTask {
		return { ...task, blocked: this.computeBlocked(file, task) };
	}

	private normalizeDependsOn(taskId: string, dependsOn: string[] | undefined): string[] | undefined {
		if (dependsOn === undefined) return undefined;
		const normalized = [...new Set(dependsOn
			.map((entry) => entry.trim())
			.filter(Boolean))];
		if (normalized.includes(taskId)) {
			throw new Error(`Task "${taskId}" cannot depend on itself.`);
		}
		return normalized;
	}

	listTasks(): TeamTask[] {
		const file = this.readFile();
		return file.tasks.map((task) => this.withBlockedState(file, task));
	}

	readTask(taskId: string): TeamTask | undefined {
		const file = this.readFile();
		const task = file.tasks.find((entry) => entry.id === taskId);
		return task ? this.withBlockedState(file, task) : undefined;
	}

	createTask(subject: string, description: string): TeamTask {
		return this.withWriteLock(() => {
			const now = Date.now();
			const file = this.readFile();
			const task: TeamTask = {
				id: `task-${randomUUID().slice(0, 8)}`,
				subject,
				description,
				status: "pending",
				dependsOn: [],
				createdAt: now,
				updatedAt: now,
				version: 1,
			};
			file.tasks.push(task);
			this.writeFile(file);
			return this.withBlockedState(file, task);
		});
	}

	updateTask(
		taskId: string,
		changes: { status?: TeamTaskStatus; owner?: string; dependsOn?: string[] },
		expectedVersion: number,
	): TeamTask {
		return this.withWriteLock(() => {
			const file = this.readFile();
			const task = file.tasks.find((entry) => entry.id === taskId);
			if (!task) {
				throw new Error(`Task not found: ${taskId}`);
			}
			if (task.version !== expectedVersion) {
				throw new TaskStoreVersionError(
					`Version mismatch for task "${taskId}": expected ${expectedVersion}, found ${task.version}`,
				);
			}
			const normalizedDependsOn = this.normalizeDependsOn(task.id, changes.dependsOn);
			if (normalizedDependsOn !== undefined) {
				task.dependsOn = normalizedDependsOn;
			}
			if (changes.status !== undefined) {
				task.status = changes.status;
			}
			if (Object.prototype.hasOwnProperty.call(changes, "owner")) {
				task.owner = changes.owner;
			}
			if ((task.status === "in_progress" || task.status === "completed") && this.computeBlocked(file, task)) {
				throw new Error(`Task "${task.id}" is blocked by unfinished dependencies.`);
			}
			task.updatedAt = Date.now();
			task.version += 1;
			this.writeFile(file);
			return this.withBlockedState(file, task);
		});
	}

	unassignTasksForOwner(ownerName: string, options: UnassignTasksForOwnerOptions = {}): UnassignTasksForOwnerResult {
		return this.withWriteLock(() => {
			const ownerKeys = new Set(
				[ownerName, ...(options.aliases ?? [])]
					.map((value) => value.trim().toLowerCase())
					.filter(Boolean),
			);
			if (ownerKeys.size === 0) {
				return { unassignedTasks: [] };
			}
			const file = this.readFile();
			const unassignedTasks: Array<{ id: string; subject: string }> = [];
			let mutated = false;
			for (const task of file.tasks) {
				if (task.status !== "pending" && task.status !== "in_progress") continue;
				const ownerKey = task.owner?.trim().toLowerCase();
				if (!ownerKey || !ownerKeys.has(ownerKey)) continue;
				task.owner = undefined;
				task.status = "pending";
				task.updatedAt = Date.now();
				task.version += 1;
				mutated = true;
				unassignedTasks.push({ id: task.id, subject: task.subject });
			}
			if (mutated) {
				this.writeFile(file);
			}
			return { unassignedTasks };
		});
	}
}
