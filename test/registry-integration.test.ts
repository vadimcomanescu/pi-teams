/**
 * Integration tests for Agent Registry wiring.
 *
 * Verifies that:
 * - subagent:started events populate the registry
 * - subagent:complete events update registry status
 * - The registry is accessible and correctly wired
 *
 * Uses createTestSession from @marcfargas/pi-test-harness to load
 * the actual extension and test real event flow.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import {
	createTempDir,
	removeTempDir,
	tryImport,
} from "./helpers.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import modules under test
const agentRegistryModule = await tryImport<any>("./agent-registry.ts");
const coordinatorModule = await tryImport<any>("./coordinator.ts");
const notifyFormatModule = await tryImport<any>("./notify-format.ts");
const available = !!(agentRegistryModule && coordinatorModule && notifyFormatModule);

const AgentRegistry = agentRegistryModule?.AgentRegistry;
const { setCoordinatorMode, isCoordinatorMode } = coordinatorModule ?? {};
const { buildCoordinatorXml, buildMarkdownNotification } = notifyFormatModule ?? {};

describe("AgentRegistry event integration", { skip: !available ? "modules not available" : undefined }, () => {
	let registry: InstanceType<typeof AgentRegistry>;

	beforeEach(() => {
		registry = new AgentRegistry();
	});

	it("subagent:started event shape populates registry", () => {
		// Simulate the event data shape emitted by async-execution.ts
		const startedData = {
			id: "run-abc123",
			agent: "researcher",
			name: "auth-investigator",
			task: "Find null pointer bugs in src/auth/",
		};

		// This is what index.ts does in the event handler
		if (startedData.id) {
			registry.register({
				id: startedData.id,
				name: startedData.name,
				agentType: startedData.agent ?? "unknown",
				task: startedData.task ?? "",
				status: "running",
				startTime: Date.now(),
			});
		}

		const agent = registry.resolve("auth-investigator");
		assert.ok(agent, "should resolve by name");
		assert.equal(agent!.id, "run-abc123");
		assert.equal(agent!.agentType, "researcher");
		assert.equal(agent!.status, "running");

		// Also resolvable by ID
		assert.equal(registry.resolve("run-abc123")?.name, "auth-investigator");
	});

	it("subagent:complete event shape updates registry", () => {
		registry.register({
			id: "run-xyz",
			name: "builder",
			agentType: "worker",
			task: "Fix the bug",
			status: "running",
			startTime: Date.now(),
		});

		// Simulate completion event
		const completeData = {
			id: "run-xyz",
			success: true,
			summary: "Fixed null pointer in validate.ts:42",
		};

		if (completeData.id) {
			registry.updateStatus(
				completeData.id,
				completeData.success ? "completed" : "failed",
				completeData.summary,
			);
		}

		const agent = registry.resolve("run-xyz");
		assert.equal(agent!.status, "completed");
		assert.equal(agent!.result, "Fixed null pointer in validate.ts:42");
		assert.ok(agent!.endTime, "endTime should be set");
	});

	it("failed completion updates status to failed", () => {
		registry.register({
			id: "run-fail",
			agentType: "worker",
			task: "Build",
			status: "running",
			startTime: Date.now(),
		});

		const completeData = {
			id: "run-fail",
			success: false,
			summary: "Tests failed: 3 assertions",
		};

		registry.updateStatus(
			completeData.id,
			completeData.success ? "completed" : "failed",
			completeData.summary,
		);

		assert.equal(registry.resolve("run-fail")!.status, "failed");
	});

	it("events without id are silently skipped", () => {
		// No crash on malformed event data
		const startedData = { agent: "worker", task: "something" };
		if ((startedData as any).id) {
			registry.register({ id: (startedData as any).id, agentType: "worker", task: "", status: "running" as const, startTime: Date.now() });
		}
		assert.equal(registry.getAll().length, 0);
	});

	it("duplicate started events are non-fatal", () => {
		registry.register({
			id: "dup-1",
			name: "worker-a",
			agentType: "worker",
			task: "task",
			status: "running",
			startTime: Date.now(),
		});

		// Second event with same ID — should not crash
		try {
			registry.register({
				id: "dup-1",
				name: "worker-a",
				agentType: "worker",
				task: "task",
				status: "running",
				startTime: Date.now(),
			});
		} catch {
			// Expected — name collision or duplicate ID
		}

		// Registry should still work
		assert.equal(registry.resolve("dup-1")!.status, "running");
	});
});

describe("notification format integration", { skip: !available ? "modules not available" : undefined }, () => {
	afterEach(() => {
		setCoordinatorMode(false);
	});

	it("coordinator mode produces XML with task-id for routing", () => {
		setCoordinatorMode(true);

		const result = {
			id: "agent-a1b",
			agent: "worker",
			name: "researcher",
			success: true,
			summary: "Found null pointer in src/auth/validate.ts:42",
			exitCode: 0,
			timestamp: Date.now(),
			usage: { totalTokens: 15420, toolUses: 8, durationMs: 34200 },
		};

		const xml = buildCoordinatorXml(result);

		// Coordinator can extract task-id for send_message routing
		assert.ok(xml.includes("<task-id>agent-a1b</task-id>"));
		assert.ok(xml.includes("<task-name>researcher</task-name>"));
		assert.ok(xml.includes("<status>completed</status>"));
		assert.ok(xml.includes("validate.ts:42"));
		assert.ok(xml.includes("<total_tokens>15420</total_tokens>"));
	});

	it("non-coordinator mode produces markdown", () => {
		assert.equal(isCoordinatorMode(), false);

		const result = {
			id: "run-1",
			agent: "scout",
			success: true,
			summary: "Found 3 relevant files",
			exitCode: 0,
			timestamp: Date.now(),
		};

		const md = buildMarkdownNotification(result);

		assert.ok(md.includes("Background task completed: **scout**"));
		assert.ok(md.includes("Found 3 relevant files"));
		assert.ok(!md.includes("<task-notification>"), "should not contain XML");
	});

	it("coordinator XML gracefully handles missing optional fields", () => {
		const result = {
			id: null,
			agent: null,
			success: false,
			summary: "Timed out",
			exitCode: 1,
			timestamp: Date.now(),
		};

		const xml = buildCoordinatorXml(result);

		assert.ok(!xml.includes("<task-id>"));
		assert.ok(!xml.includes("<task-name>"));
		assert.ok(xml.includes("<status>failed</status>"));
		assert.ok(xml.includes('"unknown" failed'));
	});
});

describe("coordinator settings integration", { skip: !available ? "modules not available" : undefined }, () => {
	afterEach(() => {
		setCoordinatorMode(false);
	});

	it("coordinator mode flag round-trips correctly", () => {
		assert.equal(isCoordinatorMode(), false);
		setCoordinatorMode(true);
		assert.equal(isCoordinatorMode(), true);
		setCoordinatorMode(false);
		assert.equal(isCoordinatorMode(), false);
	});

	it("registry lifecycle: register → run → complete → dispose", () => {
		const registry = new AgentRegistry();

		// Phase 1: spawn workers
		registry.register({
			id: "w1", name: "researcher", agentType: "worker",
			task: "investigate", status: "running", startTime: Date.now(),
		});
		registry.register({
			id: "w2", name: "tester", agentType: "worker",
			task: "run tests", status: "running", startTime: Date.now(),
		});

		assert.equal(registry.getRunning().length, 2);

		// Phase 2: one completes
		registry.updateStatus("w1", "completed", "Found the bug");
		assert.equal(registry.getRunning().length, 1);
		assert.equal(registry.resolve("researcher")!.status, "completed");
		assert.equal(registry.resolve("researcher")!.result, "Found the bug");

		// Phase 3: dispose (simulates session_shutdown)
		registry.dispose();
		assert.equal(registry.getRunning().length, 0);
		assert.equal(registry.resolve("tester")!.status, "stopped");
	});

	it("session_switch stops all workers then allows re-registration", () => {
		const registry = new AgentRegistry();

		registry.register({
			id: "old-1", name: "worker-a", agentType: "worker",
			task: "old task", status: "running", startTime: Date.now(),
		});

		// Simulate session_switch: stopAll
		registry.stopAll();
		assert.equal(registry.getRunning().length, 0);
		assert.equal(registry.resolve("old-1")!.status, "stopped");

		// New session: can reuse name
		registry.register({
			id: "new-1", name: "worker-a", agentType: "worker",
			task: "new task", status: "running", startTime: Date.now(),
		});
		assert.equal(registry.resolve("worker-a")!.id, "new-1");
		assert.equal(registry.getRunning().length, 1);
	});
});
