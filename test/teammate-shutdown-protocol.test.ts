import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../agent-registry.js";
import { clearLeaderTeamName } from "../leader-team-state.js";
import { clearSessionCreatedTeams } from "../session-created-teams.js";
import { createSendMessageTool } from "../send-message-tool.js";
import { TaskStore } from "../task-store.js";
import { TeamManager } from "../team-manager.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-shutdown-protocol-"));
}

function makeFakeRpcHandle() {
	const stdin = new PassThrough();
	let written = "";
	stdin.on("data", (chunk) => {
		written += chunk.toString();
	});
	return {
		rpcHandle: { stdin, proc: { killed: false } as any },
		get written() {
			return written;
		},
	};
}

describe("teammate graceful shutdown protocol", () => {
	let tempDir: string;
	let registry: AgentRegistry;
	let leadManager: TeamManager;
	let teammateManager: TeamManager;
	let currentTeammateTeamName: string | null;
	let currentTeammateName: string | null;

	beforeEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		tempDir = makeTempDir();
		registry = new AgentRegistry();
		currentTeammateTeamName = "review";
		currentTeammateName = "docs";
		leadManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => "lead-session",
			getCurrentTeammateTeamName: () => null,
			getCurrentTeammateName: () => null,
		});
		teammateManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => "teammate-session",
			getCurrentTeammateTeamName: () => currentTeammateTeamName,
			getCurrentTeammateName: () => currentTeammateName,
		});
	});

	afterEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function setupRunningTeammate() {
		const fake = makeFakeRpcHandle();
		leadManager.createTeam({ team_name: "review" });
		registry.register({
			id: "worker-1",
			name: "docs",
			agentType: "worker",
			task: "Review docs",
			status: "running",
			startTime: Date.now(),
			rpcHandle: fake.rpcHandle,
			runtimeRole: "teammate",
			teamMetadata: {
				teamName: "review",
				teammateName: "docs",
				teammateNames: ["docs"],
				assignedTaskIds: [],
				configPath: path.join(tempDir, "review", "config.json"),
				tasksPath: path.join(tempDir, "review", "tasks.json"),
			},
			sessionFile: "/tmp/docs.jsonl",
		});
		leadManager.registerTeammate("review", {
			name: "docs",
			agentId: "worker-1",
			agentType: "worker",
			status: "running",
			cwd: tempDir,
		});
		const store = new TaskStore("review", leadManager.getTasksPath("review"));
		const task = store.createTask("Docs review", "Check README");
		store.updateTask(task.id, { owner: "docs", status: "in_progress" }, task.version);
		return { fake, store, taskId: task.id };
	}

	it("lead can issue shutdown_request and teammate can approve, stopping one teammate and leaving the team active", async () => {
		const { store, taskId } = setupRunningTeammate();
		const leadTool = createSendMessageTool(registry, { teamManager: leadManager, runtimeRole: "lead" });
		const teammateTool = createSendMessageTool(registry, {
			teamManager: teammateManager,
			runtimeRole: "teammate",
			emitControlMessage: () => {},
		});

		const request = await leadTool.execute("request", {
			to: "docs",
			summary: "Wrap up and stop when safe",
			message: { type: "shutdown_request" },
		}, undefined, undefined, {} as any);
		assert.equal(request.isError, undefined);
		const requestId = request.details.request_id!;

		const response = await teammateTool.execute("response", {
			to: "lead",
			message: { type: "shutdown_response", request_id: requestId, approve: true },
		}, undefined, undefined, {} as any);
		assert.equal(response.isError, undefined);
		assert.equal(response.details.approved, true);

		const outcome = leadManager.handleShutdownResponseForAgent("worker-1", {
			requestId,
			approve: true,
		});
		registry.stopAgent("worker-1");
		assert.equal(outcome.approved, true);
		assert.equal(leadManager.getTeam("review")?.state, "active");
		assert.equal(leadManager.checkTeammate("review", "docs").status, "stopped");
		assert.equal(store.readTask(taskId)?.status, "pending");
		assert.equal(store.readTask(taskId)?.owner, undefined);

		const completion = leadManager.resolveTeammateCompletion("worker-1", "completed", "late completion");
		assert.equal(completion.status, "stopped");
		assert.match(completion.summary ?? "", /graceful shutdown approved/i);
	});

	it("teammate can reject shutdown and remain running with a surfaced reason", async () => {
		const { store, taskId } = setupRunningTeammate();
		const leadTool = createSendMessageTool(registry, { teamManager: leadManager, runtimeRole: "lead" });
		const teammateTool = createSendMessageTool(registry, {
			teamManager: teammateManager,
			runtimeRole: "teammate",
			emitControlMessage: () => {},
		});

		const request = await leadTool.execute("request", {
			to: "docs",
			summary: "Stop after the current checkpoint",
			message: { type: "shutdown_request" },
		}, undefined, undefined, {} as any);
		const requestId = request.details.request_id!;

		const response = await teammateTool.execute("response", {
			to: "lead",
			message: {
				type: "shutdown_response",
				request_id: requestId,
				approve: false,
				reason: "I still need to finish the README diff",
			},
		}, undefined, undefined, {} as any);
		assert.equal(response.isError, undefined);
		assert.equal(response.details.approved, false);

		const outcome = leadManager.handleShutdownResponseForAgent("worker-1", {
			requestId,
			approve: false,
			reason: "I still need to finish the README diff",
		});
		assert.equal(outcome.approved, false);
		assert.equal(leadManager.getTeam("review")?.state, "active");
		assert.equal(leadManager.checkTeammate("review", "docs").status, "running");
		assert.match(leadManager.checkTeammate("review", "docs").lastSummary ?? "", /rejected/i);
		assert.equal(store.readTask(taskId)?.status, "in_progress");
		assert.equal(store.readTask(taskId)?.owner, "docs");
	});

	it("invalid shutdown responses fail validation and do not mutate team state", async () => {
		const { store, taskId } = setupRunningTeammate();
		const leadTool = createSendMessageTool(registry, { teamManager: leadManager, runtimeRole: "lead" });
		const teammateTool = createSendMessageTool(registry, {
			teamManager: teammateManager,
			runtimeRole: "teammate",
			emitControlMessage: () => {},
		});

		const request = await leadTool.execute("request", {
			to: "docs",
			summary: "Stop after the current checkpoint",
			message: { type: "shutdown_request" },
		}, undefined, undefined, {} as any);
		assert.equal(request.isError, undefined);

		const invalid = await teammateTool.execute("response", {
			to: "lead",
			message: { type: "shutdown_response", request_id: "wrong-request", approve: true },
		}, undefined, undefined, {} as any);
		assert.equal(invalid.isError, true);
		assert.match((invalid.content[0] as { type: "text"; text: string }).text, /unknown shutdown request/i);
		assert.equal(leadManager.checkTeammate("review", "docs").status, "running");
		assert.equal(store.readTask(taskId)?.status, "in_progress");
		assert.equal(store.readTask(taskId)?.owner, "docs");
	});
});
