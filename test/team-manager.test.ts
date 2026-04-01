import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../agent-registry.js";
import { TeamConfigError, TeamManager } from "../team-manager.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-team-manager-"));
}

describe("TeamManager", () => {
	let tempDir: string;
	let registry: AgentRegistry;
	let currentSessionId: string;
	let teamManager: TeamManager;

	beforeEach(() => {
		tempDir = makeTempDir();
		registry = new AgentRegistry();
		currentSessionId = "session-a";
		teamManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => currentSessionId,
		});
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates a team and persists config.json", () => {
		const team = teamManager.createTeam({ team_name: "repo-review", description: "Review repo" });
		assert.equal(team.name, "repo-review");
		assert.equal(team.state, "active");
		assert.ok(fs.existsSync(path.join(tempDir, "repo-review", "config.json")));
	});

	it("rejects a second active team in the same session", () => {
		teamManager.createTeam({ team_name: "first" });
		assert.throws(() => teamManager.createTeam({ team_name: "second" }), /Only one active team/);
	});

	it("rejects reusing any existing team name on disk", () => {
		teamManager.createTeam({ team_name: "shared" });
		teamManager.shutdownTeam("shared", "done");
		currentSessionId = "session-b";
		const secondManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => currentSessionId,
		});
		assert.throws(() => secondManager.createTeam({ team_name: "shared" }), /cannot be reused in this pass/);
	});

	it("registers and checks a teammate with effective model", () => {
		teamManager.createTeam({ team_name: "review", default_model: "anthropic/claude-sonnet-4.6" });
		registry.register({
			id: "worker-1",
			name: "architecture",
			agentType: "worker",
			task: "Review architecture",
			status: "running",
			startTime: Date.now(),
		});
		teamManager.registerTeammate("review", {
			name: "architecture",
			agentId: "worker-1",
			agentType: "worker",
			model: undefined,
			status: "running",
			cwd: tempDir,
		});

		const teammate = teamManager.checkTeammate("review", "architecture");
		assert.equal(teammate.teamName, "review");
		assert.equal(teammate.status, "running");
		assert.equal(teammate.effectiveModel, "anthropic/claude-sonnet-4.6");
	});

	it("rejects duplicate active named-agent names", () => {
		teamManager.createTeam({ team_name: "review" });
		registry.register({
			id: "worker-1",
			name: "testing",
			agentType: "worker",
			task: "Review tests",
			status: "running",
			startTime: Date.now(),
		});
		assert.throws(
			() => teamManager.registerTeammate("review", {
				name: "testing",
				agentId: "worker-2",
				agentType: "worker",
				model: undefined,
				status: "running",
				cwd: tempDir,
			}),
			/Agent name already in use/,
		);
	});

	it("shuts down a team and preserves stopped status against later exit races", () => {
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
			model: undefined,
			status: "running",
			cwd: tempDir,
		});

		const shutdown = teamManager.shutdownTeam("review", "done");
		assert.equal(shutdown.state, "shutdown");
		assert.equal(teamManager.checkTeammate("review", "docs").status, "stopped");

		teamManager.recordTeammateStatus("worker-1", "completed", "late exit");
		assert.equal(teamManager.checkTeammate("review", "docs").status, "stopped");
	});

	it("round-trips persistence including state", () => {
		teamManager.createTeam({ team_name: "review" });
		teamManager.shutdownTeam("review", "done");
		const reloaded = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => currentSessionId,
		});
		assert.equal(reloaded.getTeam("review")?.state, "shutdown");
	});

	it("reconciles stale active teams to orphaned on bootstrap", () => {
		teamManager.createTeam({ team_name: "review" });
		currentSessionId = "session-b";
		const reloaded = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => currentSessionId,
		});
		reloaded.bootstrap();
		assert.equal(reloaded.getTeam("review")?.state, "orphaned");
	});

	it("skips corrupt configs during bootstrap and surfaces clear errors on direct access", () => {
		const corruptDir = path.join(tempDir, "broken-team");
		fs.mkdirSync(corruptDir, { recursive: true });
		fs.writeFileSync(path.join(corruptDir, "config.json"), "{bad json", "utf-8");
		assert.doesNotThrow(() => teamManager.bootstrap());
		assert.throws(() => teamManager.getTeam("broken-team"), TeamConfigError);
	});
});
