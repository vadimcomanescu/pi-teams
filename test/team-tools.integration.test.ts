import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../agent-registry.js";
import { clearLeaderTeamName } from "../leader-team-state.js";
import { clearSessionCreatedTeams } from "../session-created-teams.js";
import { TeamManager } from "../team-manager.js";
import { TaskStore } from "../task-store.js";
import {
	createCheckTeammateTool,
	createSpawnTeammateTool,
	createTeamCreateTool,
	createTeamDeleteTool,
	createTeamShutdownTool,
} from "../team-tools.js";
import {
	createTaskCreateTool,
	createTaskListTool,
	createTaskReadTool,
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
	let currentTeammateName: string | null;
	let teamManager: TeamManager;
	let spawnedRequests: any[];

	beforeEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		tempDir = makeTempDir();
		registry = new AgentRegistry();
		sessionId = "lead-session";
		currentTeammateTeamName = null;
		currentTeammateName = null;
		spawnedRequests = [];
		teamManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => sessionId,
			getCurrentTeammateTeamName: () => currentTeammateTeamName,
			getCurrentTeammateName: () => currentTeammateName,
		});
	});

	afterEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates a team, spawns a teammate, manages tasks, checks status, shuts down, and deletes the team", async () => {
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
		const deleteTeam = createTeamDeleteTool(teamManager);

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
		assert.equal(checkResult.details.mode, "default");
		assert.equal(checkResult.details.status, "completed");
		assert.equal(checkResult.details.activity, "idle");
		assert.equal(checkResult.details.is_active, false);
		assert.equal(checkResult.details.addressable, true);
		assert.equal(checkResult.details.lastSummary, "Architecture looks good");

		const taskList = await exec(listTasks, {});
		assert.match(taskList.content[0].text, /Architecture review/);

		await exec(shutdown, {});
		assert.equal(teamManager.getTeam("repo-review")?.state, "shutdown");

		const deleted = await exec(deleteTeam, {});
		assert.equal(deleted.isError, undefined);
		assert.equal(deleted.details.team_name, "repo-review");
		assert.equal(teamManager.getTeam("repo-review"), undefined);
	});

	it("reconciles spawn races where completion arrives before teammate registration", async () => {
		const createTeam = createTeamCreateTool(teamManager);
		const spawnTeammate = createSpawnTeammateTool({
			teamManager,
			listAssignedTasks: () => [],
			spawnTeammate: async (request) => {
				registry.register({
					id: "worker-race",
					name: request.name,
					agentType: "worker",
					task: request.prompt,
					status: "running",
					startTime: Date.now(),
				});
				teamManager.recordTeammateStatus("worker-race", "failed", "Spawn failed immediately");
				return { agentId: "worker-race", effectiveModel: request.effectiveModel };
			},
		});
		const checkTeammate = createCheckTeammateTool(teamManager);

		await exec(createTeam, { team_name: "repo-review" });
		const spawnResult = await exec(spawnTeammate, {
			name: "docs",
			prompt: "Review docs",
			cwd: tempDir,
		});
		assert.equal(spawnResult.isError, undefined);

		const checked = await exec(checkTeammate, { agent_name: "docs" });
		assert.equal(checked.details.status, "failed");
		assert.equal(checked.details.lastSummary, "Spawn failed immediately");
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

	it("still keeps team creation lead-owned for foreign sessions", async () => {
		const createTeam = createTeamCreateTool(teamManager);
		await exec(createTeam, { team_name: "repo-review" });

		sessionId = "foreign-session";
		const foreignManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => sessionId,
			getCurrentTeammateTeamName: () => null,
			getCurrentTeammateName: () => null,
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

	it("lets teammates claim and complete tasks from current team context", async () => {
		const createTeam = createTeamCreateTool(teamManager);
		const createTask = createTaskCreateTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});
		const updateTask = createTaskUpdateTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});
		const readTask = createTaskListTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});

		await exec(createTeam, { team_name: "repo-review" });
		const task = await exec(createTask, { subject: "Docs review", description: "Check README" });

		currentTeammateTeamName = "repo-review";
		currentTeammateName = "docs";
		sessionId = "teammate-session";

		const claimed = await exec(updateTask, { task_id: task.details.id, status: "in_progress" });
		assert.equal(claimed.isError, undefined);
		assert.equal(claimed.details.owner, "docs");
		assert.equal(claimed.details.status, "in_progress");

		const completed = await exec(updateTask, { task_id: task.details.id, status: "completed" });
		assert.equal(completed.isError, undefined);
		assert.equal(completed.details.owner, "docs");
		assert.equal(completed.details.status, "completed");

		const listed = await exec(readTask, {});
		assert.match(listed.content[0].text, /owner: docs/);
		assert.match(listed.content[0].text, /\[completed\]/);
	});

	it("supports dependency updates and blocks dependent tasks until prerequisites complete", async () => {
		const createTeam = createTeamCreateTool(teamManager);
		const createTask = createTaskCreateTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});
		const updateTask = createTaskUpdateTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});
		const listTask = createTaskListTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});
		const readTask = createTaskReadTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});

		await exec(createTeam, { team_name: "repo-review" });
		const prereq = await exec(createTask, { subject: "Prereq", description: "First" });
		const dep = await exec(createTask, { subject: "Dependent", description: "Second" });

		const linked = await exec(updateTask, { task_id: dep.details.id, depends_on: [prereq.details.id] });
		assert.equal(linked.isError, undefined);
		assert.deepEqual(linked.details.dependsOn, [prereq.details.id]);
		assert.equal(linked.details.blocked, true);

		const blockedStart = await exec(updateTask, { task_id: dep.details.id, status: "in_progress" });
		assert.equal(blockedStart.isError, true);
		assert.match(blockedStart.content[0].text, /blocked by unfinished dependencies/i);

		const listed = await exec(listTask, {});
		assert.match(listed.content[0].text, /\[blocked\]/);
		assert.match(listed.content[0].text, /depends_on:/);

		const readBlocked = await exec(readTask, { task_id: dep.details.id });
		assert.match(readBlocked.content[0].text, /Blocked: yes/);
		assert.match(readBlocked.content[0].text, /Depends on:/);

		await exec(updateTask, { task_id: prereq.details.id, status: "completed" });
		const startNow = await exec(updateTask, { task_id: dep.details.id, status: "in_progress" });
		assert.equal(startNow.isError, undefined);
		assert.equal(startNow.details.blocked, false);
	});

	it("prevents teammates from mutating dependency fields", async () => {
		const createTeam = createTeamCreateTool(teamManager);
		const createTask = createTaskCreateTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});
		const updateTask = createTaskUpdateTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});

		await exec(createTeam, { team_name: "repo-review" });
		const task = await exec(createTask, { subject: "Docs", description: "Docs" });

		currentTeammateTeamName = "repo-review";
		currentTeammateName = "docs";
		sessionId = "teammate-session";

		const result = await exec(updateTask, { task_id: task.details.id, depends_on: ["task-other"] });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /cannot edit task dependencies/i);
	});

	it("prevents teammates from taking over or deleting another teammate's task", async () => {
		const createTeam = createTeamCreateTool(teamManager);
		const createTask = createTaskCreateTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});
		const updateTask = createTaskUpdateTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});

		await exec(createTeam, { team_name: "repo-review" });
		const task = await exec(createTask, { subject: "Testing review", description: "Check coverage" });
		await exec(updateTask, { task_id: task.details.id, owner: "testing", status: "in_progress" });

		currentTeammateTeamName = "repo-review";
		currentTeammateName = "docs";
		sessionId = "teammate-session";

		const takeover = await exec(updateTask, { task_id: task.details.id, owner: "docs" });
		assert.equal(takeover.isError, true);
		assert.match(takeover.content[0].text, /owned by teammate "testing"/i);

		const deleted = await exec(updateTask, { task_id: task.details.id, status: "deleted" });
		assert.equal(deleted.isError, true);
		assert.match(deleted.content[0].text, /cannot mark tasks deleted/i);
	});

	it("refuses team_delete while a teammate is still active", async () => {
		const createTeam = createTeamCreateTool(teamManager);
		const spawnTeammate = createSpawnTeammateTool({
			teamManager,
			listAssignedTasks: () => [],
			spawnTeammate: async (request) => {
				registry.register({
					id: "worker-1",
					name: request.name,
					agentType: "worker",
					task: request.prompt,
					status: "running",
					startTime: Date.now(),
				});
				return { agentId: "worker-1", effectiveModel: request.effectiveModel };
			},
		});
		const deleteTeam = createTeamDeleteTool(teamManager);

		await exec(createTeam, { team_name: "repo-review" });
		await exec(spawnTeammate, {
			name: "docs",
			prompt: "Review docs",
			cwd: tempDir,
		});

		const deleted = await exec(deleteTeam, {});
		assert.equal(deleted.isError, true);
		assert.match(deleted.content[0].text, /non-lead teammates are active: docs/i);
	});

	it("allows team_delete without team_shutdown when no teammates are running", async () => {
		const createTeam = createTeamCreateTool(teamManager);
		const deleteTeam = createTeamDeleteTool(teamManager);

		await exec(createTeam, { team_name: "repo-review" });
		const deleted = await exec(deleteTeam, {});
		assert.equal(deleted.isError, undefined);
		assert.equal(deleted.details.noop, false);
		assert.equal(deleted.details.team_name, "repo-review");
	});

	it("returns a successful no-op when team_delete has nothing to delete", async () => {
		const deleteTeam = createTeamDeleteTool(teamManager);
		const deleted = await exec(deleteTeam, {});
		assert.equal(deleted.isError, undefined);
		assert.equal(deleted.details.noop, true);
	});

	it("prevents teammates from mutating tasks after the team is shut down", async () => {
		const createTeam = createTeamCreateTool(teamManager);
		const createTask = createTaskCreateTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});
		const updateTask = createTaskUpdateTool({
			teamManager,
			createTaskStore: (teamName) => new TaskStore(teamName, teamManager.getTasksPath(teamName)),
		});
		const shutdown = createTeamShutdownTool(teamManager);

		await exec(createTeam, { team_name: "repo-review" });
		const task = await exec(createTask, { subject: "Docs review", description: "Check README" });
		await exec(shutdown, { team_name: "repo-review" });

		currentTeammateTeamName = "repo-review";
		currentTeammateName = "docs";
		sessionId = "teammate-session";

		const result = await exec(updateTask, { task_id: task.details.id, status: "in_progress" });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /not active/i);
	});
});
