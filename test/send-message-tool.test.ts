import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { AgentRegistry } from "../agent-registry.js";
import { createSendMessageTool } from "../send-message-tool.js";

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

	beforeEach(() => {
		registry = new AgentRegistry();
	});

	it("routes a message to a running RPC agent by name and writes correct JSON to stdin", async () => {
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
		const result = await tool.execute("call-1", { to: "researcher", message: "Focus on auth module" }, undefined, undefined, {} as any);

		assert.equal(result.details.delivered, "queued");
		assert.equal(result.details.to, "researcher");
		assert.deepEqual(parseWritten(fake.written)[0], { type: "follow_up", message: "Focus on auth module" });
	});

	it("routes a message to a running RPC agent by ID", async () => {
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
		const result = await tool.execute("call-2", { to: "agent-xyz", message: "Please stop" }, undefined, undefined, {} as any);

		assert.equal(result.details.delivered, "queued");
		assert.equal(result.details.to, "agent-xyz");
		assert.deepEqual(parseWritten(fake.written)[0], { type: "follow_up", message: "Please stop" });
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
		const result = await tool.execute("call-3", { to: "bgworker", message: "hello?" }, undefined, undefined, {} as any);

		assert.equal(result.isError, true);
		assert.match((result.content[0] as { type: "text"; text: string }).text, /background mode/);
	});

	it("resumes a completed agent when a resumable session exists", async () => {
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

		const result = await tool.execute("call-4", { to: "finisher", message: "one more thing" }, undefined, undefined, {} as any);
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
		const result = await tool.execute("call-5", { to: "finisher", message: "one more thing" }, undefined, undefined, {} as any);
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
		const result = await tool.execute("call-6", { to: "charlie", message: "hello" }, undefined, undefined, {} as any);

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
		const result = await tool.execute("call-7", { to: "analyst", message: "check logs" }, undefined, undefined, {} as any);

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
		const result = await tool.execute("call-8", { to: "crasher", message: "are you there?" }, undefined, undefined, {} as any);

		assert.equal(result.isError, true);
		assert.match((result.content[0] as { type: "text"; text: string }).text, /Failed to deliver|stdin closed/);
		assert.equal(result.details.delivered, "failed");
	});

	it("writes correct JSON format: {type: 'follow_up', message: '...'}", async () => {
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
		await tool.execute("call-9", { to: "formatter", message: msg }, undefined, undefined, {} as any);

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
		const result = await tool.execute("call-10", { to: "recoverable", message: "resume" }, undefined, undefined, {} as any);
		assert.equal(result.isError, true);
		assert.match((result.content[0] as { type: "text"; text: string }).text, /resume blew up/);
	});
});
