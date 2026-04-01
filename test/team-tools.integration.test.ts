import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../agent-registry.js";
import { TeamManager } from "../team-manager.js";
import { TaskStore } from "../task-store.js";
import {
	createCheckTeammateTool,
	createSpawnTeammateTool,
	createTeamCreateTool,
	createTeamShutdownTool,
} from "../team-tools.js";
import {
	createTaskCreateTool,
	createTaskListTool,
	createTaskUpdateTool,
} from "../task-tools.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-tools-"));
}

async function exec(tool: any, params: any, ctx: any = { cwd: process.cwd() }) {
	return tool.execute("call-id", params, new AbortController().signal, undefined, ctx);
}

describe("team tools integration", () => {
	let tempDir: string;
	let registry: AgentRegistry;
	let sessionId: string;
	let currentTeammateTeamName: string | null;
	let teamManager: TeamManager;
	let spawnedRequests: any[];

	beforeEach(() => {
		tempDir = makeTempDir();
		registry = new AgentRegistry();
		sessionId = "lead-session";
		currentTeammateTeamName = null;
		spawnedRequests = [];
		teamManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => sessionId,
			getCurrentTeammateTeamName: () => currentTeammateTeamName,
		});
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates a team, spawns a teammate, manages tasks, checks status, and shuts down", async () => {
		const createTeam = createTeamCreateTool(teamManager);
		const createTask = createTaskCreateTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});
		const updateTask = createTaskUpdateTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});
		const listTasks = createTaskListTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});
		const spawnTeammate = createSpawnTeammateTool({
			teamManager,
			listAssignedTasks: (teamName, teammateName) => new TaskStore(teamName, teamManager.getTasksPath(teamName))
				.listTasks()
				.filter((task) => task.owner === teammateName),
			spawnTeammate: async (request) => {
				spawnedRequests.push(request);
				registry.register({
					id: "worker-1",
					name: request.name,
					agentType: "worker",
					task: request.prompt,
					status: "running",
					startTime: Date.now(),
					sessionFile: "/tmp/worker-1.jsonl",
				});
				return { agentId: "worker-1", effectiveModel: request.effectiveModel };
			},
		});
		const checkTeammate = createCheckTeammateTool(teamManager);
		const shutdown = createTeamShutdownTool(teamManager);

		const createdTeam = await exec(createTeam, { team_name: "repo-review", default_model: "anthropic/claude-sonnet-4.6" });
		assert.equal(createdTeam.details.team_name, "repo-review");
		const createdTask = await exec(createTask, {
			subject: "Architecture review",
			description: "Check boundaries",
		});
		assert.equal(createdTask.details.team_name, "repo-review");
		await exec(updateTask, {
			task_id: createdTask.details.id,
			owner: "architecture",
			status: "in_progress",
		});
		const spawnResult = await exec(spawnTeammate, {
			name: "architecture",
			prompt: "Review repository architecture",
			cwd: tempDir,
		});
		assert.equal(spawnResult.details.agent_id, "worker-1");
		assert.equal(spawnResult.details.model, "anthropic/claude-sonnet-4.6");
		assert.deepEqual(spawnedRequests[0].assignedTaskIds, [createdTask.details.id]);
		assert.ok(spawnedRequests[0].configPath.endsWith(path.join("repo-review", "config.json")));

		registry.updateStatus("worker-1", "completed", "Architecture looks good");
		teamManager.recordTeammateStatus("worker-1", "completed", "Architecture looks good");
		const checkResult = await exec(checkTeammate, { agent_name: "architecture" });
		assert.equal(checkResult.details.status, "completed");
		assert.equal(checkResult.details.activity, "idle");
		assert.equal(checkResult.details.addressable, true);
		assert.equal(checkResult.details.lastSummary, "Architecture looks good");

		const taskList = await exec(listTasks, {});
		assert.match(taskList.content[0].text, /Architecture review/);

		await exec(shutdown, {});
		assert.equal(teamManager.getTeam("repo-review")?.state, "shutdown");
	});

	it("lets teammates read their own team state without repeating team_name", async () => {
		teamManager.createTeam({ team_name: "repo-review" });
		const store = new TaskStore("repo-review", teamManager.getTasksPath("repo-review"));
		store.createTask("Docs review", "Check README");
		currentTeammateTeamName = "repo-review";
		const listTasks = createTaskListTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});
		const result = await exec(listTasks, {});
		assert.equal(result.isError, undefined);
		assert.match(result.content[0].text, /Docs review/);
	});

	it("only the lead session can mutate team and task state", async () => {
		const createTeam = createTeamCreateTool(teamManager);
		await exec(createTeam, { team_name: "repo-review" });

		sessionId = "teammate-session";
		const foreignManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => sessionId,
			getCurrentTeammateTeamName: () => null,
		});
		const createTask = createTaskCreateTool({
			teamManager: foreignManager,
			createTaskStore: (teamName) => new TaskStore(teamName, foreignManager.getTasksPath(teamName)),
		});

		const result = await exec(createTask, {
			team_name: "repo-review",
			subject: "Should fail",
			description: "Foreign session cannot mutate",
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Only the lead session may mutate team/);
	});
});
