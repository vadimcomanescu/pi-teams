import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskStore } from "../task-store.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-task-unassign-"));
}

describe("TaskStore.unassignTasksForOwner", () => {
	let tempDir: string;
	let store: TaskStore;

	beforeEach(() => {
		tempDir = makeTempDir();
		store = new TaskStore("review", path.join(tempDir, "tasks.json"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("unassignTasksForOwner should reset pending and in_progress tasks to unowned pending", () => {
		const pending = store.createTask("Pending task", "Investigate bug");
		const active = store.createTask("Active task", "Run tests");
		store.updateTask(pending.id, { owner: "docs" }, pending.version);
		const ownedActive = store.updateTask(active.id, { owner: "docs", status: "in_progress" }, active.version);

		const result = store.unassignTasksForOwner("docs");

		assert.deepEqual(result.unassignedTasks.map((task) => task.id).sort(), [pending.id, active.id].sort());
		assert.equal(store.readTask(pending.id)?.status, "pending");
		assert.equal(store.readTask(pending.id)?.owner, undefined);
		assert.equal(store.readTask(active.id)?.status, "pending");
		assert.equal(store.readTask(active.id)?.owner, undefined);
		assert.ok((store.readTask(active.id)?.version ?? 0) > ownedActive.version);
	});

	it("unassignTasksForOwner should preserve completed task status and owner", () => {
		const completed = store.createTask("Done task", "Ship fix");
		const inProgress = store.updateTask(completed.id, { owner: "docs", status: "completed" }, completed.version);

		const result = store.unassignTasksForOwner("docs");

		assert.deepEqual(result.unassignedTasks, []);
		assert.equal(store.readTask(completed.id)?.status, "completed");
		assert.equal(store.readTask(completed.id)?.owner, "docs");
		assert.equal(store.readTask(completed.id)?.version, inProgress.version);
	});

	it("unassignTasksForOwner should match owner aliases such as teammate agent ids", () => {
		const task = store.createTask("Docs", "Update README");
		store.updateTask(task.id, { owner: "worker-1", status: "in_progress" }, task.version);

		const result = store.unassignTasksForOwner("docs", { aliases: ["worker-1"] });

		assert.deepEqual(result.unassignedTasks.map((entry) => entry.id), [task.id]);
		assert.equal(store.readTask(task.id)?.owner, undefined);
		assert.equal(store.readTask(task.id)?.status, "pending");
	});

	it("unassignTasksForOwner should not mutate tasks owned by other teammates", () => {
		const docsTask = store.createTask("Docs", "Update README");
		const testTask = store.createTask("Tests", "Fix flake");
		store.updateTask(docsTask.id, { owner: "docs", status: "in_progress" }, docsTask.version);
		const testingAssigned = store.updateTask(testTask.id, { owner: "testing", status: "in_progress" }, testTask.version);

		const result = store.unassignTasksForOwner("docs");

		assert.deepEqual(result.unassignedTasks.map((task) => task.id), [docsTask.id]);
		assert.equal(store.readTask(testTask.id)?.owner, "testing");
		assert.equal(store.readTask(testTask.id)?.status, "in_progress");
		assert.equal(store.readTask(testTask.id)?.version, testingAssigned.version);
	});
});
