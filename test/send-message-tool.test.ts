/**
 * Integration tests for the send_message tool.
 *
 * Uses real AgentRegistry instances and PassThrough streams to verify actual
 * stdin writes. No mocking.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dynamically import modules so the file can be run without build artefacts.
import { AgentRegistry } from "../agent-registry.js";
import { createSendMessageTool } from "../send-message-tool.js";
import { setCoordinatorMode } from "../coordinator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a PassThrough-backed fake rpcHandle and collect written data. */
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

/** Read collected stdin writes as parsed JSON lines (strips trailing newlines). */
function parseWritten(written: string): unknown[] {
	return written
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("send_message tool", () => {
	let registry: InstanceType<typeof AgentRegistry>;

	beforeEach(() => {
		setCoordinatorMode(true);
		registry = new AgentRegistry();
	});

	afterEach(() => {
		setCoordinatorMode(false);
	});

	it("routes a message to a running RPC agent by name and writes correct JSON to stdin", async () => {
		const { rpcHandle, get: getWritten } = (() => {
			const fake = makeFakeRpcHandle();
			return { rpcHandle: fake.rpcHandle, get: () => fake.written };
		})();

		registry.register({
			id: "w1",
			name: "researcher",
			agentType: "worker",
			task: "investigate bugs",
			status: "running",
			startTime: Date.now(),
			rpcHandle,
		});

		const tool = createSendMessageTool(registry);
		const result = await tool.execute("call-1", { to: "researcher", message: "Focus on auth module" }, undefined, undefined, {} as any);

		assert.equal(result.details.delivered, "queued");
		assert.equal(result.details.to, "researcher");
		assert.ok(!("isError" in result) || !(result as any).isError);

		// Verify exact JSON written to stdin
		const lines = parseWritten(getWritten());
		assert.equal(lines.length, 1);
		assert.deepEqual(lines[0], { type: "follow_up", message: "Focus on auth module" });
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

		const lines = parseWritten(fake.written);
		assert.deepEqual(lines[0], { type: "follow_up", message: "Please stop" });
	});

	it("rejects message to background-mode agent (running, no rpcHandle) with helpful error", async () => {
		registry.register({
			id: "bg-1",
			name: "bgworker",
			agentType: "worker",
			task: "bg task",
			status: "running",
			startTime: Date.now(),
			// No rpcHandle — bg mode
		});

		const tool = createSendMessageTool(registry);
		const result = await tool.execute("call-3", { to: "bgworker", message: "hello?" }, undefined, undefined, {} as any);

		assert.ok((result as any).isError, "should be an error");
		assert.ok(
			result.content[0].type === "text" &&
			(result.content[0] as { type: "text"; text: string }).text.includes("background mode"),
			"error message should mention background mode",
		);
	});

	it("returns error for completed agent with status info", async () => {
		registry.register({
			id: "done-1",
			name: "finisher",
			agentType: "worker",
			task: "complete task",
			status: "running",
			startTime: Date.now(),
		});
		registry.updateStatus("done-1", "completed", "All done");

		const tool = createSendMessageTool(registry);
		const result = await tool.execute("call-4", { to: "finisher", message: "one more thing" }, undefined, undefined, {} as any);

		assert.ok((result as any).isError, "should be an error");
		const text = (result.content[0] as { type: "text"; text: string }).text;
		assert.ok(text.includes("finisher"), "should name the agent");
		assert.ok(text.includes("completed"), "should mention status");
		assert.ok(text.includes("spawn a new worker"), "should suggest spawning a new worker");
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
		const result = await tool.execute("call-5", { to: "charlie", message: "hello" }, undefined, undefined, {} as any);

		assert.ok((result as any).isError, "should be an error");
		const text = (result.content[0] as { type: "text"; text: string }).text;
		assert.ok(text.includes("charlie"), "should name the unknown agent");
		assert.ok(text.includes("alice"), "should list alice");
		assert.ok(text.includes("bob"), "should list bob");
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
		// Send using lowercase variant
		const result = await tool.execute("call-6", { to: "analyst", message: "check logs" }, undefined, undefined, {} as any);

		assert.equal(result.details.delivered, "queued");
		assert.equal(result.details.to, "Analyst");

		const lines = parseWritten(fake.written);
		assert.deepEqual(lines[0], { type: "follow_up", message: "check logs" });
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
		const result = await tool.execute("call-7", { to: "crasher", message: "are you there?" }, undefined, undefined, {} as any);

		assert.ok((result as any).isError, "should be an error");
		const text = (result.content[0] as { type: "text"; text: string }).text;
		assert.ok(text.includes("stdin closed") || text.includes("Failed to deliver"), "should mention delivery failure");
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
		await tool.execute("call-8", { to: "formatter", message: msg }, undefined, undefined, {} as any);

		const lines = parseWritten(fake.written);
		assert.equal(lines.length, 1);
		const payload = lines[0] as { type: string; message: string };
		assert.equal(payload.type, "follow_up");
		assert.equal(payload.message, msg);

		// Must be a JSON line terminated with newline
		assert.ok(fake.written.endsWith("\n"), "should end with newline");
	});

	it("returns error for failed agent with status info", async () => {
		registry.register({
			id: "failed-1",
			name: "bad-worker",
			agentType: "worker",
			task: "fail task",
			status: "running",
			startTime: Date.now(),
		});
		registry.updateStatus("failed-1", "failed", "Crashed");

		const tool = createSendMessageTool(registry);
		const result = await tool.execute("call-9", { to: "bad-worker", message: "retry?" }, undefined, undefined, {} as any);

		assert.ok((result as any).isError, "should be an error");
		const text = (result.content[0] as { type: "text"; text: string }).text;
		assert.ok(text.includes("failed"), "should mention failed status");
	});

	it("returns error for timed_out agent with status info", async () => {
		registry.register({
			id: "to-1",
			name: "slow-worker",
			agentType: "worker",
			task: "slow task",
			status: "running",
			startTime: Date.now(),
		});
		registry.updateStatus("to-1", "timed_out");

		const tool = createSendMessageTool(registry);
		const result = await tool.execute("call-10", { to: "slow-worker", message: "done yet?" }, undefined, undefined, {} as any);

		assert.ok((result as any).isError, "should be an error");
		const text = (result.content[0] as { type: "text"; text: string }).text;
		assert.ok(text.includes("timed_out"), "should mention timed_out status");
	});
});
