import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskStore, TaskStoreVersionError } from "../task-store.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-task-deps-"));
}

describe("task dependencies", () => {
	let tempDir: string;
	let store: TaskStore;
	let tasksPath: string;

	beforeEach(() => {
		tempDir = makeTempDir();
		tasksPath = path.join(tempDir, "tasks.json");
		store = new TaskStore("review", tasksPath);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips dependency fields through updates and reload", () => {
		const prereq = store.createTask("Prereq", "Finish first");
		const dependent = store.createTask("Dependent", "Wait for prereq");

		const updated = store.updateTask(dependent.id, { dependsOn: [prereq.id] }, dependent.version);
		assert.deepEqual(updated.dependsOn, [prereq.id]);

		const reloaded = new TaskStore("review", tasksPath);
		const readBack = reloaded.readTask(dependent.id);
		assert.deepEqual(readBack?.dependsOn, [prereq.id]);
	});

	it("keeps blocked tasks blocked until all prerequisites are completed", () => {
		const prereq = store.createTask("Prereq", "Finish first");
		const dependent = store.createTask("Dependent", "Wait for prereq");
		const withDeps = store.updateTask(dependent.id, { dependsOn: [prereq.id] }, dependent.version);

		assert.equal(store.readTask(withDeps.id)?.blocked, true);
		assert.throws(
			() => store.updateTask(withDeps.id, { status: "in_progress" }, withDeps.version),
			/blocked by unfinished dependencies/i,
		);

		const donePrereq = store.updateTask(prereq.id, { status: "completed" }, prereq.version);
		assert.equal(donePrereq.status, "completed");

		const unblocked = store.readTask(withDeps.id);
		assert.equal(unblocked?.blocked, false);
		const started = store.updateTask(withDeps.id, { status: "in_progress" }, unblocked!.version);
		assert.equal(started.status, "in_progress");
	});

	it("concurrent dependency updates remain lock-safe and avoid corruption", async () => {
		const prereqA = store.createTask("A", "A");
		const prereqB = store.createTask("B", "B");
		const dependent = store.createTask("Dependent", "Wait");

		const attemptOne = Promise.resolve().then(() =>
			store.updateTask(dependent.id, { dependsOn: [prereqA.id] }, dependent.version),
		);
		const attemptTwo = Promise.resolve().then(() =>
			store.updateTask(dependent.id, { dependsOn: [prereqB.id] }, dependent.version),
		);
		const results = await Promise.allSettled([attemptOne, attemptTwo]);

		const fulfilled = results.filter((entry): entry is PromiseFulfilledResult<unknown> => entry.status === "fulfilled");
		const rejected = results.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
		assert.equal(fulfilled.length, 1);
		assert.equal(rejected.length, 1);
		assert.ok(rejected[0]?.reason instanceof TaskStoreVersionError);

		const final = store.readTask(dependent.id)!;
		assert.ok(
			final.dependsOn[0] === prereqA.id || final.dependsOn[0] === prereqB.id,
			`unexpected dependsOn: ${final.dependsOn.join(",")}`,
		);
		assert.doesNotThrow(() => JSON.parse(fs.readFileSync(tasksPath, "utf-8")));
	});
});
