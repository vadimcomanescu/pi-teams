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
import { readUnreadMailboxMessages } from "../teammate-mailbox.js";
import { TeamManager } from "../team-manager.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-mode-sync-"));
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

describe("teammate mode sync", () => {
	let tempDir: string;
	let registry: AgentRegistry;
	let leadManager: TeamManager;

	beforeEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		tempDir = makeTempDir();
		registry = new AgentRegistry();
		leadManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => "lead-session",
			getCurrentTeammateTeamName: () => null,
			getCurrentTeammateName: () => null,
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
	}

	it("lead mode_set_request updates teammate mode and queues teammate notice", async () => {
		setupRunningTeammate();
		const tool = createSendMessageTool(registry, { teamManager: leadManager, runtimeRole: "lead" });

		const result = await tool.execute("mode-1", {
			to: "docs",
			message: { type: "mode_set_request", mode: "plan" },
		}, undefined, undefined, {} as any);

		assert.equal(result.isError, undefined);
		assert.equal(result.details.message_type, "mode_set_request");
		assert.equal(result.details.mode, "plan");
		assert.equal(leadManager.checkTeammate("review", "docs").mode, "plan");
		const inbox = readUnreadMailboxMessages(leadManager.getTeamDir("review"), "docs");
		assert.equal(inbox.length, 1);
		assert.equal(inbox[0]?.payload.type, "plain_text");
		if (inbox[0]?.payload.type === "plain_text") {
			assert.match(inbox[0].payload.text, /mode to "plan"/i);
		}
	});

	it("invalid mode_set_request is rejected without mutating teammate mode", async () => {
		setupRunningTeammate();
		const tool = createSendMessageTool(registry, { teamManager: leadManager, runtimeRole: "lead" });

		const result = await tool.execute("mode-2", {
			to: "docs",
			message: { type: "mode_set_request", mode: "bad-mode" },
		}, undefined, undefined, {} as any);

		assert.equal(result.isError, true);
		assert.match((result.content[0] as { type: "text"; text: string }).text, /invalid teammate mode/i);
		assert.equal(leadManager.checkTeammate("review", "docs").mode, "default");
	});

	it("non-lead runtime cannot send mode_set_request", async () => {
		setupRunningTeammate();
		const tool = createSendMessageTool(registry, { teamManager: leadManager, runtimeRole: "teammate" });

		const result = await tool.execute("mode-3", {
			to: "docs",
			message: { type: "mode_set_request", mode: "execute" },
		}, undefined, undefined, {} as any);

		assert.equal(result.isError, true);
		assert.match((result.content[0] as { type: "text"; text: string }).text, /lead session/i);
		assert.equal(leadManager.checkTeammate("review", "docs").mode, "default");
	});
});
