import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskStore, TaskStoreVersionError } from "../task-store.js";
import { withFileLock } from "../state-file-utils.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-task-store-"));
}

describe("TaskStore", () => {
	let tempDir: string;
	let store: TaskStore;
	let tasksPath: string;

	beforeEach(() => {
		tempDir = makeTempDir();
		tasksPath = path.join(tempDir, "tasks.json");
		store = new TaskStore("demo-team", tasksPath);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates, lists, reads, and updates tasks", () => {
		const created = store.createTask("Architecture review", "Review boundaries");
		assert.equal(created.status, "pending");
		assert.equal(store.listTasks().length, 1);
		assert.equal(store.readTask(created.id)?.subject, "Architecture review");

		const updated = store.updateTask(created.id, { owner: "architecture", status: "in_progress" }, created.version);
		assert.equal(updated.owner, "architecture");
		assert.equal(updated.status, "in_progress");
		assert.equal(updated.version, 2);
	});

	it("rejects stale updates when versions do not match", () => {
		const created = store.createTask("Testing review", "Review coverage");
		store.updateTask(created.id, { status: "in_progress" }, created.version);
		assert.throws(
			() => store.updateTask(created.id, { status: "completed" }, created.version),
			TaskStoreVersionError,
		);
	});

	it("persists owner assignment and status transitions", () => {
		const created = store.createTask("Docs review", "Check README");
		const claimed = store.updateTask(created.id, { owner: "docs", status: "in_progress" }, created.version);
		const completed = store.updateTask(claimed.id, { status: "completed" }, claimed.version);
		assert.equal(completed.owner, "docs");
		assert.equal(completed.status, "completed");
	});

	it("writes atomically without leaving temp files behind", () => {
		const created = store.createTask("DX review", "Check help text");
		store.updateTask(created.id, { owner: "dx" }, created.version);
		const dirEntries = fs.readdirSync(tempDir);
		assert.ok(dirEntries.includes("tasks.json"));
		assert.ok(!dirEntries.some((entry) => entry.endsWith(".tmp")), `unexpected temp files: ${dirEntries.join(", ")}`);
		const raw = JSON.parse(fs.readFileSync(tasksPath, "utf-8"));
		assert.equal(raw.schemaVersion, 1);
		assert.equal(raw.tasks.length, 1);
	});

	it("fails clearly on corrupt tasks.json", () => {
		fs.writeFileSync(tasksPath, "{not valid json", "utf-8");
		assert.throws(() => store.listTasks(), /Corrupt tasks\.json/);
	});

	it("rejects legacy tasks.json that only has version field", () => {
		fs.writeFileSync(tasksPath, JSON.stringify({ version: 1, tasks: [] }), "utf-8");
		assert.throws(() => store.listTasks(), /schemaVersion: 1/);
	});

	it("serializes writes with a file lock", () => {
		assert.throws(
			() => withFileLock(tasksPath, () => withFileLock(tasksPath, () => undefined, { timeoutMs: 20, retryDelayMs: 5 })),
			/Timed out acquiring file lock/,
		);
	});
});
