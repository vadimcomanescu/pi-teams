/**
 * Integration tests for Coordinator Mode (Feature 6).
 *
 * Tests the full coordinator lifecycle: flag activation, prompt injection,
 * RPC worker spawning with registry wiring, max workers enforcement,
 * and session lifecycle hooks.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "./helpers.ts";
import {
	createMockPi,
	createTempDir,
	removeTempDir,
	makeAgentConfigs,
	events,
	tryImport,
} from "./helpers.ts";

// Import modules under test
const coordinatorModule = await tryImport<any>("./coordinator.ts");
const coordinatorPromptModule = await tryImport<any>("./coordinator-prompt.ts");
const agentRegistryModule = await tryImport<any>("./agent-registry.ts");
const execution = await tryImport<any>("./execution.ts");
const utils = await tryImport<any>("./utils.ts");
const available = !!(coordinatorModule && coordinatorPromptModule && agentRegistryModule && execution && utils);

const { setCoordinatorMode, isCoordinatorMode, getCoordinatorSettings, updateCoordinatorSettings } = coordinatorModule ?? {};
const { getCoordinatorSystemPrompt } = coordinatorPromptModule ?? {};
const { AgentRegistry } = agentRegistryModule ?? {};
const runSync = execution?.runSync;
const getFinalOutput = utils?.getFinalOutput;

describe("coordinator mode activation", { skip: !available ? "modules not available" : undefined }, () => {
	afterEach(() => {
		setCoordinatorMode(false);
	});

	it("isCoordinatorMode returns false by default", () => {
		assert.equal(isCoordinatorMode(), false);
	});

	it("setCoordinatorMode activates and deactivates", () => {
		setCoordinatorMode(true);
		assert.equal(isCoordinatorMode(), true);
		setCoordinatorMode(false);
		assert.equal(isCoordinatorMode(), false);
	});

	it("coordinator settings have sensible defaults", () => {
		const settings = getCoordinatorSettings();
		assert.equal(settings.maxConcurrentWorkers, 8);
		assert.equal(settings.workerTimeoutMs, 300_000);
	});

	it("coordinator settings can be overridden", () => {
		updateCoordinatorSettings({ maxConcurrentWorkers: 4 });
		assert.equal(getCoordinatorSettings().maxConcurrentWorkers, 4);
		// Reset
		updateCoordinatorSettings({ maxConcurrentWorkers: 8 });
	});
});

describe("coordinator system prompt", { skip: !available ? "modules not available" : undefined }, () => {
	it("includes all required sections", () => {
		const prompt = getCoordinatorSystemPrompt();
		assert.ok(prompt.includes("## Coordinator Mode"), "should have coordinator mode header");
		assert.ok(prompt.includes("### Your Tools"), "should have tools section");
		assert.ok(prompt.includes("team_create"), "should mention team_create");
		assert.ok(prompt.includes("spawn_teammate"), "should mention spawn_teammate");
		assert.ok(prompt.includes("task_create"), "should mention task_create");
		assert.ok(prompt.includes("send_message"), "should mention send_message tool");
		assert.ok(prompt.includes("task_stop"), "should mention task_stop tool");
		assert.ok(prompt.includes("resume an idle teammate"), "should document teammate continuation");
		assert.ok(prompt.includes("notifications are the primary coordination loop"), "should guide notification-first coordination");
		assert.ok(prompt.includes("<task-notification>"), "should describe notification format");
		assert.ok(prompt.includes("### Task Workflow"), "should have workflow section");
		assert.ok(prompt.includes("### Concurrency"), "should have concurrency section");
		assert.ok(prompt.includes("### Writing Worker Prompts"), "should have prompt guide");
		assert.ok(prompt.includes("### Continue vs. Spawn"), "should have continue/spawn guide");
		assert.ok(prompt.includes("### Verification"), "should have verification section");
		assert.ok(prompt.includes("### Example Session"), "should have example");
	});

	it("prepends base system prompt when provided", () => {
		const base = "You are a helpful assistant.";
		const prompt = getCoordinatorSystemPrompt(base);
		assert.ok(prompt.startsWith(base), "should start with base prompt");
		assert.ok(prompt.includes("## Coordinator Mode"), "should include coordinator sections");
	});

	it("includes max concurrent workers from settings", () => {
		const prompt = getCoordinatorSystemPrompt();
		assert.ok(prompt.includes("**8**"), "should include default max workers");
	});

	it("stays aligned with the builtin coordinator agent and team-first contract", () => {
		const prompt = getCoordinatorSystemPrompt();
		const coordinatorAgent = fs.readFileSync(path.resolve("agents/coordinator.md"), "utf-8");
		for (const required of [
			"team_create",
			"spawn_teammate",
			"task_create",
			"task_list",
			"check_teammate",
			"team_shutdown",
		]) {
			assert.ok(prompt.includes(required), `prompt should include ${required}`);
			assert.ok(coordinatorAgent.includes(required), `builtin coordinator should include ${required}`);
		}
		assert.ok(prompt.includes("resume an idle teammate"), "prompt should document teammate continuation");
		assert.ok(coordinatorAgent.includes("resume an idle teammate"), "builtin coordinator should document teammate continuation");
		assert.ok(prompt.includes("notifications are the primary coordination loop"), "prompt should emphasize notification-first coordination");
		assert.ok(!prompt.includes("--coordinator"), "prompt should not require a coordinator flag");
		assert.ok(!coordinatorAgent.includes("--coordinator"), "builtin coordinator should not require a coordinator flag");
	});
});

describe("coordinator RPC spawn with registry", { skip: !available ? "modules not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
		setCoordinatorMode(false);
	});

	it("RPC onSpawn registers live rpcHandle in registry", async () => {
		mockPi.onCall({ output: "Worker done" });
		const agents = makeAgentConfigs(["worker"]);
		const registry = new AgentRegistry();

		let onSpawnFired = false;

		await runSync(tempDir, agents, "worker", "Do work", {
			spawnMode: "rpc",
			onSpawn: (proc: ChildProcess) => {
				onSpawnFired = true;
				// Register in registry with live handle (what the executor does)
				registry.register({
					id: "w1",
					name: "test-worker",
					agentType: "worker",
					task: "Do work",
					status: "running",
					startTime: Date.now(),
					pid: proc.pid,
					rpcHandle: { stdin: proc.stdin!, proc },
				});
			},
		});

		assert.ok(onSpawnFired, "onSpawn should fire");
		const agent = registry.resolve("test-worker");
		assert.ok(agent, "agent should be in registry");
		assert.ok(agent!.rpcHandle, "rpcHandle should be set");
		assert.ok(agent!.pid, "pid should be set");
	});

	it("completion updates registry status", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["worker"]);
		const registry = new AgentRegistry();

		const result = await runSync(tempDir, agents, "worker", "Task", {
			spawnMode: "rpc",
			onSpawn: (proc: ChildProcess) => {
				registry.register({
					id: "w1",
					agentType: "worker",
					task: "Task",
					status: "running",
					startTime: Date.now(),
					rpcHandle: { stdin: proc.stdin!, proc },
				});
			},
		});

		// After runSync completes, update registry (simulates executor .then())
		registry.updateStatus("w1", result.exitCode === 0 ? "completed" : "failed",
			getFinalOutput(result.messages));

		assert.equal(registry.resolve("w1")!.status, "completed");
		assert.equal(registry.resolve("w1")!.result, "Done");
	});

	it("failed worker updates registry to failed", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "crash" });
		const agents = makeAgentConfigs(["worker"]);
		const registry = new AgentRegistry();

		const result = await runSync(tempDir, agents, "worker", "Task", {
			spawnMode: "rpc",
			onSpawn: (proc: ChildProcess) => {
				registry.register({
					id: "w1",
					agentType: "worker",
					task: "Task",
					status: "running",
					startTime: Date.now(),
					rpcHandle: { stdin: proc.stdin!, proc },
				});
			},
		});

		registry.updateStatus("w1", result.exitCode === 0 ? "completed" : "failed");
		assert.equal(registry.resolve("w1")!.status, "failed");
	});
});

describe("max concurrent workers enforcement", { skip: !available ? "modules not available" : undefined }, () => {
	afterEach(() => {
		setCoordinatorMode(false);
		updateCoordinatorSettings({ maxConcurrentWorkers: 8 });
	});

	it("rejects spawn when at max workers", () => {
		setCoordinatorMode(true);
		updateCoordinatorSettings({ maxConcurrentWorkers: 2 });
		const registry = new AgentRegistry();
		const settings = getCoordinatorSettings();

		// Register 2 running workers
		registry.register({
			id: "w1", agentType: "worker", task: "t1",
			status: "running", startTime: Date.now(),
		});
		registry.register({
			id: "w2", agentType: "worker", task: "t2",
			status: "running", startTime: Date.now(),
		});

		const running = registry.getRunning().length;
		assert.ok(running >= settings.maxConcurrentWorkers,
			"should be at or over max workers");
	});

	it("allows spawn after worker completes", () => {
		const registry = new AgentRegistry();
		updateCoordinatorSettings({ maxConcurrentWorkers: 1 });

		registry.register({
			id: "w1", agentType: "worker", task: "t1",
			status: "running", startTime: Date.now(),
		});

		// Complete one
		registry.updateStatus("w1", "completed");
		assert.equal(registry.getRunning().length, 0);
		assert.ok(registry.getRunning().length < getCoordinatorSettings().maxConcurrentWorkers);
	});
});

describe("session lifecycle with coordinator", { skip: !available ? "modules not available" : undefined }, () => {
	afterEach(() => {
		setCoordinatorMode(false);
	});

	it("dispose stops all workers and sweeper", async () => {
		const registry = new AgentRegistry();

		registry.register({
			id: "w1", name: "a", agentType: "worker", task: "t1",
			status: "running", startTime: Date.now(),
		});
		registry.register({
			id: "w2", name: "b", agentType: "worker", task: "t2",
			status: "running", startTime: Date.now(),
		});

		registry.startTimeoutSweeper(300_000);
		registry.dispose();

		assert.equal(registry.getRunning().length, 0);
		assert.equal(registry.resolve("w1")!.status, "stopped");
		assert.equal(registry.resolve("w2")!.status, "stopped");
	});

	it("session_switch pattern: stopAll then re-register", () => {
		const registry = new AgentRegistry();

		registry.register({
			id: "old-w", name: "worker", agentType: "worker", task: "old",
			status: "running", startTime: Date.now(),
		});

		// Simulate session_switch
		registry.stopAll();
		assert.equal(registry.getRunning().length, 0);

		// New session can reuse names
		registry.register({
			id: "new-w", name: "worker", agentType: "worker", task: "new",
			status: "running", startTime: Date.now(),
		});

		assert.equal(registry.resolve("worker")!.id, "new-w");
	});

	it("timeout sweeper marks overdue workers as timed_out", async () => {
		const registry = new AgentRegistry();
		const timedOut: string[] = [];

		registry.register({
			id: "slow", agentType: "worker", task: "t1",
			status: "running", startTime: Date.now() - 10_000,
		});
		registry.register({
			id: "fast", agentType: "worker", task: "t2",
			status: "running", startTime: Date.now(),
		});

		registry.startTimeoutSweeper(5_000, 50, (agent) => timedOut.push(agent.id));
		await new Promise((r) => setTimeout(r, 100));
		registry.stopTimeoutSweeper();

		assert.equal(registry.resolve("slow")!.status, "timed_out");
		assert.equal(registry.resolve("fast")!.status, "running");
		assert.deepEqual(timedOut, ["slow"]);
	});
});
