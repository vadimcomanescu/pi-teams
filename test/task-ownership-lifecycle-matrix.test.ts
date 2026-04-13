import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../agent-registry.js";
import { clearLeaderTeamName } from "../leader-team-state.js";
import { clearSessionCreatedTeams } from "../session-created-teams.js";
import { TaskStore } from "../task-store.js";
import { createTaskStopTool } from "../task-stop-tool.js";
import { TeamManager } from "../team-manager.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-owner-matrix-"));
}

function createHarness(tempDir: string) {
	const registry = new AgentRegistry();
	const teamManager = new TeamManager({
		registry,
		rootDir: tempDir,
		getCurrentSessionId: () => "lead-session",
		getCurrentTeammateTeamName: () => null,
		getCurrentTeammateName: () => null,
	});
	teamManager.createTeam({ team_name: "review" });
	registry.register({
		id: "worker-1",
		name: "docs",
		agentType: "worker",
		task: "Review docs",
		status: "running",
		startTime: Date.now(),
	});
	teamManager.registerTeammate("review", {
		name: "docs",
		agentId: "worker-1",
		agentType: "worker",
		status: "running",
		cwd: tempDir,
	});
	const store = new TaskStore("review", teamManager.getTasksPath("review"));
	const task = store.createTask("Docs review", "Check README");
	store.updateTask(task.id, { owner: "docs", status: "in_progress" }, task.version);
	return { registry, teamManager, store, taskId: task.id };
}

describe("task ownership lifecycle matrix", () => {
	let tempDir: string;

	beforeEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		tempDir = makeTempDir();
	});

	afterEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("unassigns open tasks when teammate status becomes failed", () => {
		const { teamManager, store, taskId } = createHarness(tempDir);
		teamManager.recordTeammateStatus("worker-1", "failed", "Tool error");

		const task = store.readTask(taskId)!;
		assert.equal(task.status, "pending");
		assert.equal(task.owner, undefined);
	});

	it("unassigns open tasks when teammate status becomes timed_out", () => {
		const { teamManager, store, taskId } = createHarness(tempDir);
		teamManager.recordTeammateStatus("worker-1", "timed_out", "Timed out");

		const task = store.readTask(taskId)!;
		assert.equal(task.status, "pending");
		assert.equal(task.owner, undefined);
	});

	it("unassigns open tasks when lead requests team_shutdown", () => {
		const { teamManager, store, taskId } = createHarness(tempDir);
		teamManager.shutdownTeam("review", "done");

		const task = store.readTask(taskId)!;
		assert.equal(task.status, "pending");
		assert.equal(task.owner, undefined);
	});

	it("unassigns open tasks when graceful shutdown is approved", () => {
		const { teamManager, store, taskId } = createHarness(tempDir);
		teamManager.recordShutdownRequest("worker-1", "req-1", "wrap up");
		const outcome = teamManager.handleShutdownResponseForAgent("worker-1", {
			requestId: "req-1",
			approve: true,
		});

		assert.equal(outcome.approved, true);
		const task = store.readTask(taskId)!;
		assert.equal(task.status, "pending");
		assert.equal(task.owner, undefined);
	});

	it("unassigns open tasks when task_stop stops the teammate", async () => {
		const { registry, teamManager, store, taskId } = createHarness(tempDir);
		const tool = createTaskStopTool(registry, (agent) => {
			teamManager.unassignOpenTasksForAgent(agent.id);
		});
		const result = await tool.execute("call-id", { task_id: "docs" }, new AbortController().signal, undefined, {} as any);
		assert.equal(result.isError, undefined);

		const task = store.readTask(taskId)!;
		assert.equal(task.status, "pending");
		assert.equal(task.owner, undefined);
	});
});
