import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../agent-registry.js";
import { clearLeaderTeamName } from "../leader-team-state.js";
import { clearSessionCreatedTeams, getSessionCreatedTeams } from "../session-created-teams.js";
import { TaskStore } from "../task-store.js";
import { TeamManager } from "../team-manager.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-session-cleanup-"));
}

describe("TeamManager session cleanup", () => {
	let tempDir: string;
	let registry: AgentRegistry;
	let currentSessionId: string;
	let teamManager: TeamManager;

	beforeEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		tempDir = makeTempDir();
		registry = new AgentRegistry();
		currentSessionId = "lead-session";
		teamManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => currentSessionId,
			getCurrentTeammateTeamName: () => null,
			getCurrentTeammateName: () => null,
		});
	});

	afterEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("tracks teams created in the lead session", () => {
		teamManager.createTeam({ team_name: "repo-review" });
		assert.deepEqual(getSessionCreatedTeams(currentSessionId), ["repo-review"]);
	});

	it("explicit delete unregisters a team from session cleanup tracking", () => {
		teamManager.createTeam({ team_name: "repo-review" });
		teamManager.shutdownTeam("repo-review", "done");
		teamManager.deleteTeam();
		assert.deepEqual(getSessionCreatedTeams(currentSessionId), []);
	});

	it("cleanupSessionTeams stops remaining teammate runtimes before deleting tracked team state", () => {
		teamManager.createTeam({ team_name: "repo-review" });
		new TaskStore("repo-review", teamManager.getTasksPath("repo-review")).createTask("Docs review", "Check README");
		registry.register({
			id: "worker-1",
			name: "docs",
			agentType: "worker",
			task: "Review docs",
			status: "running",
			startTime: Date.now(),
		});
		teamManager.registerTeammate("repo-review", {
			name: "docs",
			agentId: "worker-1",
			agentType: "worker",
			model: undefined,
			status: "running",
			cwd: tempDir,
		});

		const cleaned = teamManager.cleanupSessionTeams("Lead session shutdown");
		assert.deepEqual(cleaned.teamNames, ["repo-review"]);
		assert.deepEqual(cleaned.cleanedTeams, ["repo-review"]);
		assert.deepEqual(cleaned.failures, []);
		assert.equal(registry.resolve("worker-1")?.status, "stopped");
		assert.equal(fs.existsSync(teamManager.getTeamDir("repo-review")), false);
		assert.deepEqual(getSessionCreatedTeams(currentSessionId), []);
	});

	it("cleanupSessionTeams continues when stopping one teammate runtime fails", () => {
		const failingRegistry = new AgentRegistry();
		const originalStopAgent = failingRegistry.stopAgent.bind(failingRegistry);
		failingRegistry.stopAgent = ((id: string) => {
			if (id === "worker-1") {
				throw new Error("simulated stop failure");
			}
			originalStopAgent(id);
		}) as AgentRegistry["stopAgent"];
		teamManager = new TeamManager({
			registry: failingRegistry,
			rootDir: tempDir,
			getCurrentSessionId: () => currentSessionId,
			getCurrentTeammateTeamName: () => null,
			getCurrentTeammateName: () => null,
		});

		teamManager.createTeam({ team_name: "first" });
		teamManager.shutdownTeam("first", "done");

		teamManager.createTeam({ team_name: "second" });
		new TaskStore("second", teamManager.getTasksPath("second")).createTask("Tests", "Check cleanup");
		failingRegistry.register({
			id: "worker-1",
			name: "docs",
			agentType: "worker",
			task: "Review docs",
			status: "running",
			startTime: Date.now(),
		});
		teamManager.registerTeammate("second", {
			name: "docs",
			agentId: "worker-1",
			agentType: "worker",
			model: undefined,
			status: "running",
			cwd: tempDir,
		});

		const cleaned = teamManager.cleanupSessionTeams("Lead session shutdown");
		assert.deepEqual(cleaned.cleanedTeams.sort(), ["first", "second"].sort());
		assert.equal(cleaned.failures.length, 1);
		assert.match(cleaned.failures[0]?.message ?? "", /simulated stop failure/);
		assert.equal(fs.existsSync(teamManager.getTeamDir("first")), false);
		assert.equal(fs.existsSync(teamManager.getTeamDir("second")), false);
		assert.deepEqual(getSessionCreatedTeams(currentSessionId), []);
	});
});
