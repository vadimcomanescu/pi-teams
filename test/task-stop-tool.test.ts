/**
 * Integration tests for the TaskStop tool.
 *
 * Uses a real AgentRegistry instance — no mocks.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../agent-registry.js";
import { clearLeaderTeamName } from "../leader-team-state.js";
import { clearSessionCreatedTeams } from "../session-created-teams.js";
import { TaskStore } from "../task-store.js";
import { createTaskStopTool } from "../task-stop-tool.js";
import { TeamManager } from "../team-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(): AgentRegistry {
	return new AgentRegistry();
}

function registerRunning(
	registry: AgentRegistry,
	overrides: Partial<{
		id: string;
		name: string;
		agentType: string;
		task: string;
	}> = {},
) {
	const agent = {
		id: overrides.id ?? "agent-001",
		name: overrides.name ?? "worker",
		agentType: overrides.agentType ?? "worker",
		task: overrides.task ?? "do work",
		status: "running" as const,
		startTime: Date.now(),
	};
	registry.register(agent);
	return agent;
}

/** Call tool.execute with minimal required harness arguments. */
async function callExecute(
	tool: ReturnType<typeof createTaskStopTool>,
	params: { task_id: string; reason?: string },
) {
	// execute signature: (id, params, signal, onUpdate, ctx)
	return tool.execute!(
		"test-call-id",
		params,
		new AbortController().signal,
		() => {},
		{} as any,
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("task_stop tool", () => {
	let registry: AgentRegistry;
	let tool: ReturnType<typeof createTaskStopTool>;
	let tempDir: string;

	beforeEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		registry = makeRegistry();
		tool = createTaskStopTool(registry);
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-task-stop-"));
	});

	afterEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("stops a running agent by name and returns success", async () => {
		registerRunning(registry, { id: "run-1", name: "researcher" });

		const result = await callExecute(tool, { task_id: "researcher" });

		assert.equal((result as any).isError, undefined);
		const text = (result as any).content[0].text as string;
		assert.ok(text.includes("researcher"), `Expected agent name in output, got: ${text}`);
		const details = (result as any).details;
		assert.equal(details.status, "stopped");
		assert.equal(details.task_id, "run-1");
		assert.equal(details.agent, "worker");
	});

	it("stops a running agent by ID and returns success", async () => {
		registerRunning(registry, { id: "run-42", name: "builder" });

		const result = await callExecute(tool, { task_id: "run-42" });

		assert.equal((result as any).isError, undefined);
		const details = (result as any).details;
		assert.equal(details.task_id, "run-42");
		assert.equal(details.status, "stopped");
	});

	it("returns error for non-running agent with current status", async () => {
		registerRunning(registry, { id: "run-done", name: "tester" });
		registry.updateStatus("run-done", "completed", "All tests passed");

		const result = await callExecute(tool, { task_id: "tester" });

		assert.equal((result as any).isError, true);
		const text = (result as any).content[0].text as string;
		assert.ok(
			text.includes("completed"),
			`Expected status in error message, got: ${text}`,
		);
	});

	it("returns error for unknown agent with list of available names", async () => {
		registerRunning(registry, { id: "run-a", name: "alpha" });
		registerRunning(registry, { id: "run-b", name: "beta" });

		const result = await callExecute(tool, { task_id: "ghost" });

		assert.equal((result as any).isError, true);
		const text = (result as any).content[0].text as string;
		assert.ok(text.includes("ghost"), `Expected task_id in error, got: ${text}`);
		assert.ok(text.includes("alpha"), `Expected available agent names, got: ${text}`);
		assert.ok(text.includes("beta"), `Expected available agent names, got: ${text}`);
	});

	it("includes reason in output when provided", async () => {
		registerRunning(registry, { id: "run-3", name: "scout" });

		const result = await callExecute(tool, {
			task_id: "scout",
			reason: "task superseded by parallel run",
		});

		assert.equal((result as any).isError, undefined);
		const text = (result as any).content[0].text as string;
		assert.ok(
			text.includes("task superseded by parallel run"),
			`Expected reason in output, got: ${text}`,
		);
	});

	it("registry status is updated to stopped after tool call", async () => {
		registerRunning(registry, { id: "run-4", name: "fixer" });

		assert.equal(registry.resolve("fixer")!.status, "running");

		await callExecute(tool, { task_id: "fixer" });

		assert.equal(registry.resolve("fixer")!.status, "stopped");
	});

	it("stop callback can unassign the teammate's open tasks", async () => {
		const teamManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => "lead-session",
			getCurrentTeammateTeamName: () => null,
			getCurrentTeammateName: () => null,
		});
		teamManager.createTeam({ team_name: "review" });
		registerRunning(registry, { id: "run-5", name: "docs" });
		teamManager.registerTeammate("review", {
			name: "docs",
			agentId: "run-5",
			agentType: "worker",
			model: undefined,
			status: "running",
			cwd: tempDir,
		});
		const store = new TaskStore("review", teamManager.getTasksPath("review"));
		const task = store.createTask("Docs review", "Check README");
		store.updateTask(task.id, { owner: "docs", status: "in_progress" }, task.version);
		tool = createTaskStopTool(registry, (agent) => {
			teamManager.unassignOpenTasksForAgent(agent.id);
		});

		await callExecute(tool, { task_id: "docs", reason: "superseded" });

		assert.equal(store.readTask(task.id)?.owner, undefined);
		assert.equal(store.readTask(task.id)?.status, "pending");
	});
});
