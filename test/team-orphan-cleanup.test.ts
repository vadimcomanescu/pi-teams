import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../agent-registry.js";
import { clearLeaderTeamName } from "../leader-team-state.js";
import { clearSessionCreatedTeams } from "../session-created-teams.js";
import { TeamManager } from "../team-manager.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-orphan-cleanup-"));
}

function markTeamAsOrphaned(manager: TeamManager, teamName: string, shutdownAt: number): void {
	const configPath = manager.getConfigPath(teamName);
	const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
	config.state = "orphaned";
	config.shutdownAt = shutdownAt;
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

describe("TeamManager orphan cleanup", () => {
	let tempDir: string;
	let registry: AgentRegistry;
	let currentSessionId: string;
	let nowMs: number;
	let teamManager: TeamManager;

	beforeEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		tempDir = makeTempDir();
		registry = new AgentRegistry();
		currentSessionId = "lead-session";
		nowMs = 1_000_000;
		teamManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => currentSessionId,
			getCurrentTeammateTeamName: () => null,
			getCurrentTeammateName: () => null,
			now: () => nowMs,
		});
	});

	afterEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("removes stale orphan team dirs older than threshold", () => {
		teamManager.createTeam({ team_name: "stale" });
		teamManager.shutdownTeam("stale", "done");
		markTeamAsOrphaned(teamManager, "stale", nowMs - 100_000);

		const cleaned = teamManager.cleanupOrphanedTeams(60_000);

		assert.deepEqual(cleaned.removedTeams, ["stale"]);
		assert.deepEqual(cleaned.failures, []);
		assert.equal(fs.existsSync(teamManager.getTeamDir("stale")), false);
	});

	it("preserves active/current team dirs during orphan cleanup", () => {
		teamManager.createTeam({ team_name: "stale" });
		teamManager.shutdownTeam("stale", "done");
		markTeamAsOrphaned(teamManager, "stale", nowMs - 100_000);
		teamManager.createTeam({ team_name: "active" });

		const cleaned = teamManager.cleanupOrphanedTeams(60_000);

		assert.deepEqual(cleaned.removedTeams, ["stale"]);
		assert.equal(fs.existsSync(teamManager.getTeamDir("active")), true);
		assert.equal(teamManager.getTeam("active")?.state, "active");
	});

	it("continues cleanup when one team dir has malformed config", () => {
		teamManager.createTeam({ team_name: "stale" });
		teamManager.shutdownTeam("stale", "done");
		markTeamAsOrphaned(teamManager, "stale", nowMs - 100_000);

		const brokenDir = path.join(tempDir, "broken");
		fs.mkdirSync(brokenDir, { recursive: true });
		fs.writeFileSync(path.join(brokenDir, "config.json"), "{not-json");

		assert.doesNotThrow(() => teamManager.cleanupOrphanedTeams(60_000));
		assert.equal(fs.existsSync(teamManager.getTeamDir("stale")), false);
		assert.equal(fs.existsSync(path.join(brokenDir, "config.json")), true);
	});
});
