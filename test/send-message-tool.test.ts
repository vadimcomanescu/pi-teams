import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../agent-registry.js";
import { clearLeaderTeamName } from "../leader-team-state.js";
import { clearSessionCreatedTeams } from "../session-created-teams.js";
import { createSendMessageTool } from "../send-message-tool.js";
import { TeamManager } from "../team-manager.js";

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

function parseWritten(written: string): unknown[] {
	return written
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("send_message tool", () => {
	let registry: AgentRegistry;
	let tempDir: string;
	let teamManager: TeamManager;

	beforeEach(() => {
		clearLeaderTeamName();
		clearSessionCreatedTeams();
		registry = new AgentRegistry();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-send-message-"));
		teamManager = new TeamManager({
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

	it("queues a plain follow-up for a running RPC teammate when summary is provided", async () => {
		const fake = makeFakeRpcHandle();
		registry.register({
			id: "w1",
			name: "researcher",
			agentType: "worker",
			task: "investigate bugs",
			status: "running",
			startTime: Date.now(),
			rpcHandle: fake.rpcHandle,
		});

		const tool = createSendMessageTool(registry);
		const result = await tool.execute("call-1", {
			to: "researcher",
			summary: "Ask for auth focus",
			message: "Focus on auth module",
		}, undefined, undefined, {} as any);

		assert.equal(result.details.delivered, "queued");
		assert.equal(result.details.to, "researcher");
		assert.equal(result.details.message_type, "plain_text");
		assert.deepEqual(parseWritten(fake.written)[0], { type: "follow_up", message: "Focus on auth module" });
	});

	it("routes a plain follow-up to a running RPC agent by ID", async () => {
		const fake = makeFakeRpcHandle();
		registry.register({
			id: "agent-xyz",
			agentType: "worker",
			task: "build",
			status: "running",
			startTime: Date.now(),
			rpcHandle: fake.rpcHandle,
		});

		const tool = createSendMessageTool(registry);
		const result = await tool.execute("call-2", {
			to: "agent-xyz",
			summary: "Request stop",
			message: "Please stop",
		}, undefined, undefined, {} as any);

		assert.equal(result.details.delivered, "queued");
		assert.equal(result.details.to, "agent-xyz");
		assert.deepEqual(parseWritten(fake.written)[0], { type: "follow_up", message: "Please stop" });
	});

	it("rejects a plain-text follow-up without summary", async () => {
		const fake = makeFakeRpcHandle();
		registry.register({
			id: "w1",
			name: "researcher",
			agentType: "worker",
			task: "investigate bugs",
			status: "running",
			startTime: Date.now(),
			rpcHandle: fake.rpcHandle,
		});

		const tool = createSendMessageTool(registry);
		const result = await tool.execute("call-plain-summary", {
			to: "researcher",
			message: "Focus on auth module",
		}, undefined, undefined, {} as any);

		assert.equal(result.isError, true);
		assert.match((result.content[0] as { type: "text"; text: string }).text, /requires a non-empty summary/i);
		assert.equal(fake.written, "");
	});

	it("rejects message to background-mode agent (running, no rpcHandle) with helpful error", async () => {
		registry.register({
			id: "bg-1",
			name: "bgworker",
			agentType: "worker",
			task: "bg task",
			status: "running",
			startTime: Date.now(),
		});

		const tool = createSendMessageTool(registry);
		const result = await tool.execute("call-3", {
			to: "bgworker",
			summary: "Ping background worker",
			message: "hello?",
		}, undefined, undefined, {} as any);

		assert.equal(result.isError, true);
		assert.match((result.content[0] as { type: "text"; text: string }).text, /background mode/);
	});

	it("resumes an idle teammate with a session for a plain follow-up when summary is provided", async () => {
		registry.register({
			id: "done-1",
			name: "finisher",
			agentType: "worker",
			task: "complete task",
			status: "completed",
			startTime: Date.now() - 1000,
			sessionFile: "/tmp/finisher.jsonl",
		});
		const resumed: Array<{ id: string; message: string }> = [];
		const tool = createSendMessageTool(registry, {
			resumeAgent: async (agent, message) => {
				resumed.push({ id: agent.id, message });
				registry.register({
					id: "done-2",
					name: agent.name,
					agentType: agent.agentType,
					task: message,
					status: "running",
					startTime: Date.now(),
					sessionFile: agent.sessionFile,
				});
				return { agentId: "done-2" };
			},
		});

		const result = await tool.execute("call-4", {
			to: "finisher",
			summary: "Need one more thing",
			message: "one more thing",
		}, undefined, undefined, {} as any);
		assert.equal(result.isError, undefined);
		assert.equal(result.details.delivered, "resumed");
		assert.equal(result.details.agent_id, "done-2");
		assert.deepEqual(resumed, [{ id: "done-1", message: "one more thing" }]);
		assert.equal(registry.resolve("finisher")?.id, "done-2");
	});

	it("returns a clear error for idle agents without a resumable session", async () => {
		registry.register({
			id: "done-1",
			name: "finisher",
			agentType: "worker",
			task: "complete task",
			status: "completed",
			startTime: Date.now() - 1000,
		});
		const tool = createSendMessageTool(registry, {
			resumeAgent: async () => ({ agentId: "should-not-run" }),
		});
		const result = await tool.execute("call-5", {
			to: "finisher",
			summary: "Need one more thing",
			message: "one more thing",
		}, undefined, undefined, {} as any);
		assert.equal(result.isError, true);
		assert.match((result.content[0] as { type: "text"; text: string }).text, /no resumable session/i);
	});

	it("returns error for unknown agent with available names list", async () => {
		registry.register({
			id: "known-1",
			name: "alice",
			agentType: "worker",
			task: "task",
			status: "running",
			startTime: Date.now(),
		});
		registry.register({
			id: "known-2",
			name: "bob",
			agentType: "worker",
			task: "task",
			status: "running",
			startTime: Date.now(),
		});

		const tool = createSendMessageTool(registry);
		const result = await tool.execute("call-6", {
			to: "charlie",
			summary: "hello",
			message: "hello",
		}, undefined, undefined, {} as any);

		assert.equal(result.isError, true);
		const text = (result.content[0] as { type: "text"; text: string }).text;
		assert.ok(text.includes("charlie"));
		assert.ok(text.includes("alice"));
		assert.ok(text.includes("bob"));
	});

	it("case-insensitive name matching routes correctly", async () => {
		const fake = makeFakeRpcHandle();
		registry.register({
			id: "w2",
			name: "Analyst",
			agentType: "worker",
			task: "analyse",
			status: "running",
			startTime: Date.now(),
			rpcHandle: fake.rpcHandle,
		});

		const tool = createSendMessageTool(registry);
		const result = await tool.execute("call-7", {
			to: "analyst",
			summary: "Check logs",
			message: "check logs",
		}, undefined, undefined, {} as any);

		assert.equal(result.details.delivered, "queued");
		assert.equal(result.details.to, "Analyst");
		assert.deepEqual(parseWritten(fake.written)[0], { type: "follow_up", message: "check logs" });
	});

	it("handles broken stdin (write throws) gracefully", async () => {
		const brokenStdin = {
			write(_data: string): void {
				throw new Error("EPIPE: broken pipe");
			},
		};

		registry.register({
			id: "crashed-1",
			name: "crasher",
			agentType: "worker",
			task: "crash task",
			status: "running",
			startTime: Date.now(),
			rpcHandle: { stdin: brokenStdin as any, proc: { killed: true } as any },
		});

		const tool = createSendMessageTool(registry);
		const result = await tool.execute("call-8", {
			to: "crasher",
			summary: "Are you there",
			message: "are you there?",
		}, undefined, undefined, {} as any);

		assert.equal(result.isError, true);
		assert.match((result.content[0] as { type: "text"; text: string }).text, /Failed to deliver|stdin closed/);
		assert.equal(result.details.delivered, "failed");
	});

	it("writes the exact follow_up JSON format for plain text messages", async () => {
		const fake = makeFakeRpcHandle();
		const msg = "Multi-line test\nwith newlines";
		registry.register({
			id: "format-test",
			name: "formatter",
			agentType: "worker",
			task: "format task",
			status: "running",
			startTime: Date.now(),
			rpcHandle: fake.rpcHandle,
		});

		const tool = createSendMessageTool(registry);
		await tool.execute("call-9", {
			to: "formatter",
			summary: "Multi-line follow-up",
			message: msg,
		}, undefined, undefined, {} as any);

		const payload = parseWritten(fake.written)[0] as { type: string; message: string };
		assert.equal(payload.type, "follow_up");
		assert.equal(payload.message, msg);
		assert.ok(fake.written.endsWith("\n"));
	});

	it("returns a clear error when resume callback fails", async () => {
		registry.register({
			id: "idle-1",
			name: "recoverable",
			agentType: "worker",
			task: "recover task",
			status: "stopped",
			startTime: Date.now() - 1000,
			sessionFile: "/tmp/recoverable.jsonl",
		});
		const tool = createSendMessageTool(registry, {
			resumeAgent: async () => {
				throw new Error("resume blew up");
			},
		});
		const result = await tool.execute("call-10", {
			to: "recoverable",
			summary: "resume",
			message: "resume",
		}, undefined, undefined, {} as any);
		assert.equal(result.isError, true);
		assert.match((result.content[0] as { type: "text"; text: string }).text, /resume blew up/);
	});

	it("accepts a shutdown_request payload without breaking plain follow-up routing", async () => {
		const fake = makeFakeRpcHandle();
		teamManager.createTeam({ team_name: "review" });
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
		});
		teamManager.registerTeammate("review", {
			name: "docs",
			agentId: "worker-1",
			agentType: "worker",
			status: "running",
			cwd: tempDir,
		});

		const tool = createSendMessageTool(registry, { teamManager, runtimeRole: "lead" });
		const result = await tool.execute("call-shutdown-request", {
			to: "docs",
			summary: "Wrap up and stop when safe",
			message: { type: "shutdown_request" },
		}, undefined, undefined, {} as any);

		assert.equal(result.isError, undefined);
		assert.equal(result.details.message_type, "shutdown_request");
		assert.ok(result.details.request_id);
		const payload = parseWritten(fake.written)[0] as { type: string; message: string };
		assert.equal(payload.type, "follow_up");
		assert.match(payload.message, /graceful shutdown/i);
		assert.match(payload.message, /shutdown_response/);
		assert.match(payload.message, new RegExp(result.details.request_id!));
		assert.equal(teamManager.getTeam("review")?.members[0]?.pendingShutdownRequestId, result.details.request_id);
	});

	it("does not persist a shutdown request when delivery fails", async () => {
		const brokenStdin = {
			write(_data: string): void {
				throw new Error("EPIPE: broken pipe");
			},
		};
		teamManager.createTeam({ team_name: "review" });
		registry.register({
			id: "worker-1",
			name: "docs",
			agentType: "worker",
			task: "Review docs",
			status: "running",
			startTime: Date.now(),
			rpcHandle: { stdin: brokenStdin as any, proc: { killed: true } as any },
			runtimeRole: "teammate",
			teamMetadata: {
				teamName: "review",
				teammateName: "docs",
				teammateNames: ["docs"],
				assignedTaskIds: [],
				configPath: path.join(tempDir, "review", "config.json"),
				tasksPath: path.join(tempDir, "review", "tasks.json"),
			},
		});
		teamManager.registerTeammate("review", {
			name: "docs",
			agentId: "worker-1",
			agentType: "worker",
			status: "running",
			cwd: tempDir,
		});

		const tool = createSendMessageTool(registry, { teamManager, runtimeRole: "lead" });
		const result = await tool.execute("call-shutdown-request-fail", {
			to: "docs",
			summary: "Wrap up and stop when safe",
			message: { type: "shutdown_request" },
		}, undefined, undefined, {} as any);

		assert.equal(result.isError, true);
		assert.equal(teamManager.getTeam("review")?.members[0]?.pendingShutdownRequestId, undefined);
	});

	it("emits a shutdown_response control event for lead-side routing", async () => {
		teamManager.createTeam({ team_name: "review" });
		teamManager.registerTeammate("review", {
			name: "docs",
			agentId: "worker-1",
			agentType: "worker",
			status: "running",
			cwd: tempDir,
		});
		teamManager.recordShutdownRequest("worker-1", "req-1", "wrap up");
		const teammateManager = new TeamManager({
			registry,
			rootDir: tempDir,
			getCurrentSessionId: () => "teammate-session",
			getCurrentTeammateTeamName: () => "review",
			getCurrentTeammateName: () => "docs",
		});
		const writes: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		(process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = ((chunk: string | Uint8Array) => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as typeof process.stdout.write;
		try {
			const tool = createSendMessageTool(registry, { teamManager: teammateManager, runtimeRole: "teammate" });
			const result = await tool.execute("call-shutdown-response", {
				to: "lead",
				message: { type: "shutdown_response", request_id: "req-1", approve: true },
			}, undefined, undefined, {} as any);
			assert.equal(result.isError, undefined);
			assert.equal(result.details.approved, true);
			assert.ok(writes.some((line) => line.includes('"teammate_control_message"')));
			assert.ok(writes.some((line) => line.includes('"requestId":"req-1"')));
		} finally {
			(process.stdout.write as unknown as typeof process.stdout.write) = originalWrite;
		}
	});

	it("rejects shutdown_response approval when routed anywhere except the lead", async () => {
		const tool = createSendMessageTool(registry, { teamManager, runtimeRole: "teammate" });
		const result = await tool.execute("call-invalid-target", {
			to: "docs",
			message: { type: "shutdown_response", request_id: "req-1", approve: true },
		}, undefined, undefined, {} as any);

		assert.equal(result.isError, true);
		assert.match((result.content[0] as { type: "text"; text: string }).text, /must target the lead/i);
	});

	it("rejects shutdown_response rejection without a non-empty reason", async () => {
		const tool = createSendMessageTool(registry, { teamManager, runtimeRole: "teammate" });
		const result = await tool.execute("call-missing-reason", {
			to: "lead",
			message: { type: "shutdown_response", request_id: "req-1", approve: false },
		}, undefined, undefined, {} as any);

		assert.equal(result.isError, true);
		assert.match((result.content[0] as { type: "text"; text: string }).text, /requires a non-empty reason/i);
	});

	it("rejects structured shutdown messages that try to broadcast", async () => {
		const tool = createSendMessageTool(registry, { teamManager, runtimeRole: "lead" });
		const result = await tool.execute("call-broadcast", {
			to: "*",
			message: { type: "shutdown_request" },
		}, undefined, undefined, {} as any);

		assert.equal(result.isError, true);
		assert.match((result.content[0] as { type: "text"; text: string }).text, /cannot be broadcast/i);
	});
});
