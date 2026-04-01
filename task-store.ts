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
	createdAt: number;
	updatedAt: number;
	version: number;
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
				tasks: parsed.tasks.map((task) => ({ ...task })),
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

	listTasks(): TeamTask[] {
		return this.readFile().tasks;
	}

	readTask(taskId: string): TeamTask | undefined {
		return this.readFile().tasks.find((task) => task.id === taskId);
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
				createdAt: now,
				updatedAt: now,
				version: 1,
			};
			file.tasks.push(task);
			this.writeFile(file);
			return task;
		});
	}

	updateTask(
		taskId: string,
		changes: { status?: TeamTaskStatus; owner?: string },
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
			if (changes.status !== undefined) {
				task.status = changes.status;
			}
			if (Object.prototype.hasOwnProperty.call(changes, "owner")) {
				task.owner = changes.owner;
			}
			task.updatedAt = Date.now();
			task.version += 1;
			this.writeFile(file);
			return { ...task };
		});
	}
}
