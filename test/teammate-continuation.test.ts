import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../agent-registry.js";
import { createResumeAgent } from "../teammate-continuation.js";
import { TeamManager } from "../team-manager.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-continuation-"));
}

describe("createResumeAgent", () => {
	let tempDir: string;
	let registry: AgentRegistry;
	let teamManager: TeamManager;

	beforeEach(() => {
		tempDir = makeTempDir();
		registry = new AgentRegistry();
		teamManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => "lead-session",
			getCurrentTeammateTeamName: () => null,
		});
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("rebinds a teammate to the new agent id after resuming", async () => {
		teamManager.createTeam({ team_name: "review" });
		teamManager.registerTeammate("review", {
			name: "docs",
			agentId: "worker-1",
			agentType: "worker",
			status: "completed",
			cwd: tempDir,
		});
		const calls: Array<{ id: string; task?: string; sessionFile?: string }> = [];
		const resumeAgent = createResumeAgent({
			execute: async (id, params) => {
				calls.push({ id, task: params.task, sessionFile: params.sessionFile });
				return {
					content: [{ type: "text", text: "resumed" }],
					details: { mode: "single", results: [], asyncId: "worker-2" },
				};
			},
			teamManager,
			getFallbackCwd: () => tempDir,
		});

		const resumed = await resumeAgent({
			id: "worker-1",
			name: "docs",
			agentType: "worker",
			task: "initial task",
			status: "completed",
			startTime: Date.now() - 1000,
			sessionFile: "/tmp/docs.jsonl",
			cwd: tempDir,
			runtimeRole: "teammate",
			teamMetadata: {
				teamName: "review",
				teammateName: "docs",
				teammateNames: ["docs"],
				assignedTaskIds: [],
				configPath: path.join(tempDir, "review", "config.json"),
				tasksPath: path.join(tempDir, "review", "tasks.json"),
			},
		}, "follow up on docs", undefined, { cwd: tempDir });

		assert.equal(resumed.agentId, "worker-2");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.task, "follow up on docs");
		assert.equal(calls[0]?.sessionFile, "/tmp/docs.jsonl");
		const teammate = teamManager.checkTeammate("review", "docs");
		assert.equal(teammate.member.agentId, "worker-2");
		assert.equal(teammate.status, "running");
	});
});
