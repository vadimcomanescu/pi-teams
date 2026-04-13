import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { AgentRegistry } from "../agent-registry.js";
import { clearLeaderTeamName } from "../leader-team-state.js";
import { clearSessionCreatedTeams } from "../session-created-teams.js";
import { TeamManager } from "../team-manager.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-idle-active-"));
}

function makeFakeRpcHandle() {
	const stdin = new PassThrough();
	return { stdin, proc: { killed: false } as any };
}

describe("TeamManager idle/active lifecycle", () => {
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

	it("persists running to idle to running teammate activity for live teammates", () => {
		teamManager.createTeam({ team_name: "review" });
		registry.register({
			id: "worker-1",
			name: "docs",
			agentType: "worker",
			task: "Review docs",
			status: "running",
			startTime: Date.now(),
			rpcHandle: makeFakeRpcHandle(),
			sessionFile: "/tmp/docs.jsonl",
		});
		teamManager.registerTeammate("review", {
			name: "docs",
			agentId: "worker-1",
			agentType: "worker",
			status: "running",
			cwd: tempDir,
		});

		const running = teamManager.checkTeammate("review", "docs");
		assert.equal(running.status, "running");
		assert.equal(running.lifecycle.activity, "running");
		assert.equal(running.member.isActive, true);
		assert.equal(running.lifecycle.canQueueFollowUp, true);

		teamManager.recordTeammateActivity("worker-1", false, "Waiting for follow-up");

		const idle = teamManager.checkTeammate("review", "docs");
		assert.equal(idle.status, "running");
		assert.equal(idle.lifecycle.activity, "idle");
		assert.equal(idle.member.isActive, false);
		assert.equal(idle.lifecycle.addressable, true);
		assert.equal(idle.lifecycle.canQueueFollowUp, true);
		assert.equal(idle.lifecycle.canResume, false);
		assert.equal(idle.lastSummary, "Waiting for follow-up");

		teamManager.recordTeammateActivity("worker-1", true);

		const resumed = teamManager.checkTeammate("review", "docs");
		assert.equal(resumed.lifecycle.activity, "running");
		assert.equal(resumed.member.isActive, true);
	});

	it("reports completed teammates with a session as idle and resumable", () => {
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
			status: "completed",
			cwd: tempDir,
		});

		const teammate = teamManager.checkTeammate("review", "docs");
		assert.equal(teammate.lifecycle.activity, "idle");
		assert.equal(teammate.member.isActive, false);
		assert.equal(teammate.lifecycle.addressable, true);
		assert.equal(teammate.lifecycle.canResume, true);
		assert.equal(teammate.lifecycle.canQueueFollowUp, false);
	});

	it("marks shutdown and orphaned teammates as non-addressable", () => {
		teamManager.createTeam({ team_name: "review" });
		registry.register({
			id: "worker-1",
			name: "docs",
			agentType: "worker",
			task: "Review docs",
			status: "running",
			startTime: Date.now(),
			rpcHandle: makeFakeRpcHandle(),
			sessionFile: "/tmp/docs.jsonl",
		});
		teamManager.registerTeammate("review", {
			name: "docs",
			agentId: "worker-1",
			agentType: "worker",
			status: "running",
			cwd: tempDir,
		});

		teamManager.shutdownTeam("review", "done");
		const shutdownTeammate = teamManager.checkTeammate("review", "docs");
		assert.equal(shutdownTeammate.state, "shutdown");
		assert.equal(shutdownTeammate.lifecycle.activity, "idle");
		assert.equal(shutdownTeammate.member.isActive, false);
		assert.equal(shutdownTeammate.lifecycle.addressable, false);

		currentSessionId = "session-b";
		const orphanedManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => currentSessionId,
			getCurrentTeammateTeamName: () => null,
			getCurrentTeammateName: () => null,
		});
		orphanedManager.createTeam({ team_name: "review-2" });
		registry.register({
			id: "worker-2",
			name: "testing",
			agentType: "worker",
			task: "Review tests",
			status: "running",
			startTime: Date.now(),
			rpcHandle: makeFakeRpcHandle(),
			sessionFile: "/tmp/testing.jsonl",
		});
		orphanedManager.registerTeammate("review-2", {
			name: "testing",
			agentId: "worker-2",
			agentType: "worker",
			status: "running",
			cwd: tempDir,
		});

		currentSessionId = "session-c";
		const reloaded = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => currentSessionId,
			getCurrentTeammateTeamName: () => null,
			getCurrentTeammateName: () => null,
		});
		reloaded.bootstrap();

		const orphanedTeammate = reloaded.checkTeammate("review-2", "testing");
		assert.equal(orphanedTeammate.state, "orphaned");
		assert.equal(orphanedTeammate.lifecycle.activity, "idle");
		assert.equal(orphanedTeammate.member.isActive, false);
		assert.equal(orphanedTeammate.lifecycle.addressable, false);
	});
});
