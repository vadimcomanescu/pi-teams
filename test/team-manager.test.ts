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
	let currentTeammateTeamName: string | null;
	let currentTeammateName: string | null;
	let teamManager: TeamManager;

	beforeEach(() => {
		tempDir = makeTempDir();
		registry = new AgentRegistry();
		currentSessionId = "session-a";
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

	it("smooths name collisions by choosing a safe alternative", () => {
		teamManager.createTeam({ team_name: "shared" });
		teamManager.shutdownTeam("shared", "done");
		currentSessionId = "session-b";
		const secondManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => currentSessionId,
			getCurrentTeammateTeamName: () => null,
			getCurrentTeammateName: () => null,
		});
		const created = secondManager.createTeam({ team_name: "shared" });
		assert.equal(created.name, "shared-2");
		assert.ok(fs.existsSync(path.join(tempDir, "shared-2", "config.json")));
	});

	it("rejects unsafe dot-segment team names", () => {
		assert.throws(() => teamManager.createTeam({ team_name: "." }), /Unsafe team name/);
		assert.throws(() => teamManager.createTeam({ team_name: ".." }), /Unsafe team name/);
	});

	it("keeps resolved team paths inside the teams root", () => {
		const configPath = teamManager.getConfigPath("../../escape");
		const relative = path.relative(tempDir, configPath);
		assert.equal(path.isAbsolute(relative), false);
		assert.equal(relative === ".." || relative.startsWith(`..${path.sep}`), false);
		assert.throws(() => teamManager.getTeamDir(".."), /Unsafe team name/);
	});

	it("resolves omitted team_name to the active team in the lead session", () => {
		teamManager.createTeam({ team_name: "review" });
		assert.equal(teamManager.resolveTeamName(), "review");
		assert.equal(teamManager.assertLeadControl().name, "review");
	});

	it("resolves omitted team_name to the teammate's own team", () => {
		teamManager.createTeam({ team_name: "review" });
		currentTeammateTeamName = "review";
		assert.equal(teamManager.resolveTeamName(), "review");
		assert.equal(teamManager.assertTeamAccess().name, "review");
	});

	it("lets a teammate resolve task mutation access for their own team", () => {
		teamManager.createTeam({ team_name: "review" });
		currentSessionId = "teammate-session";
		currentTeammateTeamName = "review";
		currentTeammateName = "docs";
		const access = teamManager.assertTaskMutationAccess();
		assert.equal(access.team.name, "review");
		assert.equal(access.actor.kind, "teammate");
		assert.equal(access.actor.name, "docs");
	});

	it("rejects teammate task mutation when teammate identity is missing", () => {
		teamManager.createTeam({ team_name: "review" });
		currentSessionId = "teammate-session";
		currentTeammateTeamName = "review";
		assert.throws(() => teamManager.assertTaskMutationAccess(), /Teammate identity is unavailable/);
	});

	it("rejects teammate task mutation when the team is not active", () => {
		teamManager.createTeam({ team_name: "review" });
		teamManager.shutdownTeam("review", "done");
		currentSessionId = "teammate-session";
		currentTeammateTeamName = "review";
		currentTeammateName = "docs";
		assert.throws(() => teamManager.assertTaskMutationAccess(), /not active/);
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

	it("rebinds a resumed teammate to the latest agent id by name", () => {
		teamManager.createTeam({ team_name: "review" });
		registry.register({
			id: "worker-1",
			name: "docs",
			agentType: "worker",
			task: "Review docs",
			status: "completed",
			startTime: Date.now() - 1000,
			sessionFile: "/tmp/docs.jsonl",
		});
		teamManager.registerTeammate("review", {
			name: "docs",
			agentId: "worker-1",
			agentType: "worker",
			model: undefined,
			status: "completed",
			cwd: tempDir,
		});
		registry.register({
			id: "worker-2",
			name: "docs",
			agentType: "worker",
			task: "Follow up on docs",
			status: "running",
			startTime: Date.now(),
		});
		teamManager.registerTeammate("review", {
			name: "docs",
			agentId: "worker-2",
			agentType: "worker",
			model: undefined,
			status: "running",
			cwd: tempDir,
		});

		const teammate = teamManager.checkTeammate("review", "docs");
		assert.equal(teammate.member.agentId, "worker-2");
		assert.equal(teammate.status, "running");
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

		registry.updateStatus("worker-1", "completed", "late exit");
		teamManager.recordTeammateStatus("worker-1", "completed", "late exit");
		assert.equal(teamManager.checkTeammate("review", "docs").status, "stopped");
	});

	it("preserves timed_out status against later process exit races", () => {
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

		registry.updateStatus("worker-1", "timed_out", "Timed out after 5000ms");
		teamManager.recordTeammateStatus("worker-1", "timed_out", "Timed out after 5000ms");
		assert.equal(teamManager.checkTeammate("review", "docs").status, "timed_out");

		registry.updateStatus("worker-1", "failed", "late exit after timeout");
		teamManager.recordTeammateStatus("worker-1", "failed", "late exit after timeout");
		const status = teamManager.checkTeammate("review", "docs");
		assert.equal(status.status, "timed_out");
		assert.equal(status.lastSummary, "Timed out after 5000ms");
	});

	it("round-trips persistence including state", () => {
		teamManager.createTeam({ team_name: "review" });
		teamManager.shutdownTeam("review", "done");
		const reloaded = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => currentSessionId,
			getCurrentTeammateTeamName: () => currentTeammateTeamName,
			getCurrentTeammateName: () => currentTeammateName,
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
			getCurrentTeammateTeamName: () => null,
			getCurrentTeammateName: () => null,
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
