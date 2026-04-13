import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../agent-registry.js";
import { clearLeaderTeamName } from "../leader-team-state.js";
import { clearSessionCreatedTeams } from "../session-created-teams.js";
import { TaskStore } from "../task-store.js";
import { TeamManager } from "../team-manager.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-delete-team-"));
}

describe("TeamManager.deleteTeam", () => {
	let tempDir: string;
	let registry: AgentRegistry;
	let currentSessionId: string;
	let currentTeammateTeamName: string | null;
	let currentTeammateName: string | null;
	let teamManager: TeamManager;

	beforeEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		tempDir = makeTempDir();
		registry = new AgentRegistry();
		currentSessionId = "lead-session";
		currentTeammateTeamName = null;
		currentTeammateName = null;
		teamManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => currentSessionId,
			getCurrentTeammateTeamName: () => currentTeammateTeamName,
			getCurrentTeammateName: () => currentTeammateName,
		});
	});

	afterEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("deleteTeam should remove config and tasks directories for a shutdown team", () => {
		teamManager.createTeam({ team_name: "repo-review" });
		const store = new TaskStore("repo-review", teamManager.getTasksPath("repo-review"));
		store.createTask("Docs review", "Check README");
		teamManager.shutdownTeam("repo-review", "done");

		const deleted = teamManager.deleteTeam();
		assert.equal(deleted.noop, false);
		assert.equal(deleted.teamName, "repo-review");
		assert.equal(deleted.leadStateCleared, true);
		assert.deepEqual(
			deleted.removedPaths.sort(),
			[
				teamManager.getConfigPath("repo-review"),
				teamManager.getTasksPath("repo-review"),
				teamManager.getTeamDir("repo-review"),
			].sort(),
		);
		assert.equal(teamManager.getTeam("repo-review"), undefined);
		assert.equal(fs.existsSync(teamManager.getTeamDir("repo-review")), false);
		assert.equal(teamManager.resolveCurrentTeamName(), undefined);
	});

	it("deleteTeam should allow deletion without shutdown when no teammates are active", () => {
		teamManager.createTeam({ team_name: "repo-review" });
		registry.register({
			id: "worker-1",
			name: "docs",
			agentType: "worker",
			task: "Review docs",
			status: "completed",
			startTime: Date.now(),
		});
		teamManager.registerTeammate("repo-review", {
			name: "docs",
			agentId: "worker-1",
			agentType: "worker",
			model: undefined,
			status: "completed",
			cwd: tempDir,
		});

		const deleted = teamManager.deleteTeam();
		assert.equal(deleted.noop, false);
		assert.equal(deleted.teamName, "repo-review");
		assert.equal(fs.existsSync(teamManager.getConfigPath("repo-review")), false);
	});

	it("deleteTeam should refuse deletion while non-lead teammates are active", () => {
		teamManager.createTeam({ team_name: "repo-review" });
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

		assert.throws(() => teamManager.deleteTeam(), /non-lead teammates are active: docs/);
		assert.ok(fs.existsSync(teamManager.getConfigPath("repo-review")));
	});

	it("deleteTeam should succeed as a no-op when there is no current team", () => {
		const deleted = teamManager.deleteTeam();
		assert.equal(deleted.noop, true);
		assert.deepEqual(deleted.removedPaths, []);
		assert.equal(deleted.leadStateCleared, true);
	});

	it("deleteTeam should still work after the manager is recreated for the same lead session", () => {
		teamManager.createTeam({ team_name: "repo-review" });
		const store = new TaskStore("repo-review", teamManager.getTasksPath("repo-review"));
		store.createTask("Docs review", "Check README");
		teamManager.shutdownTeam("repo-review", "done");

		teamManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => currentSessionId,
			getCurrentTeammateTeamName: () => currentTeammateTeamName,
			getCurrentTeammateName: () => currentTeammateName,
		});

		const deleted = teamManager.deleteTeam();
		assert.equal(deleted.noop, false);
		assert.equal(deleted.teamName, "repo-review");
		assert.equal(fs.existsSync(teamManager.getTeamDir("repo-review")), false);
	});

	it("deleteTeam should be safe to retry after cleanup", () => {
		teamManager.createTeam({ team_name: "repo-review" });
		teamManager.shutdownTeam("repo-review", "done");

		const first = teamManager.deleteTeam();
		const second = teamManager.deleteTeam();

		assert.equal(first.noop, false);
		assert.equal(second.noop, true);
		assert.deepEqual(second.removedPaths, []);
	});

	it("deleteTeam should reject non-lead callers", () => {
		teamManager.createTeam({ team_name: "repo-review" });
		teamManager.shutdownTeam("repo-review", "done");
		currentSessionId = "teammate-session";
		currentTeammateTeamName = "repo-review";
		currentTeammateName = "docs";

		assert.throws(() => teamManager.deleteTeam(), /Only the lead session may delete the current team/);
	});
});
