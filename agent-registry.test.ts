import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { AgentRegistry } from "./agent-registry.ts";
import type { RegisteredAgent } from "./agent-registry.ts";

function makeAgent(overrides: Partial<RegisteredAgent> = {}): RegisteredAgent {
	return {
		id: overrides.id ?? `agent-${Math.random().toString(36).slice(2, 8)}`,
		agentType: "worker",
		task: "test task",
		status: "running",
		startTime: Date.now(),
		...overrides,
	};
}

describe("AgentRegistry", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		registry = new AgentRegistry();
	});

	describe("register and resolve", () => {
		it("registers and resolves by ID", () => {
			const agent = makeAgent({ id: "abc-123" });
			registry.register(agent);
			assert.equal(registry.resolve("abc-123"), agent);
		});

		it("registers and resolves by name", () => {
			const agent = makeAgent({ name: "researcher" });
			registry.register(agent);
			assert.equal(registry.resolve("researcher"), agent);
		});

		it("resolves by name case-insensitively", () => {
			const agent = makeAgent({ name: "Researcher" });
			registry.register(agent);
			assert.equal(registry.resolve("researcher"), agent);
			assert.equal(registry.resolve("RESEARCHER"), agent);
			assert.equal(registry.resolve("Researcher"), agent);
		});

		it("returns undefined for unknown name or id", () => {
			assert.equal(registry.resolve("nonexistent"), undefined);
		});

		it("prefers name index over ID for resolution", () => {
			const agent = makeAgent({ id: "id-1", name: "scout" });
			registry.register(agent);
			// Both should work
			assert.equal(registry.resolve("scout"), agent);
			assert.equal(registry.resolve("id-1"), agent);
		});
	});

	describe("name collisions", () => {
		it("throws when name is already used by a running agent", () => {
			registry.register(makeAgent({ id: "a1", name: "worker" }));
			assert.throws(
				() => registry.register(makeAgent({ id: "a2", name: "worker" })),
				/already in use/,
			);
		});

		it("allows name reuse after previous agent completed", () => {
			registry.register(makeAgent({ id: "a1", name: "worker" }));
			registry.updateStatus("a1", "completed");
			// Should not throw
			const a2 = makeAgent({ id: "a2", name: "worker" });
			registry.register(a2);
			assert.equal(registry.resolve("worker"), a2);
		});

		it("throws on duplicate ID", () => {
			registry.register(makeAgent({ id: "dup" }));
			assert.throws(
				() => registry.register(makeAgent({ id: "dup" })),
				/already registered/,
			);
		});
	});

	describe("updateStatus", () => {
		it("transitions from running to completed", () => {
			const agent = makeAgent({ id: "a1" });
			registry.register(agent);
			registry.updateStatus("a1", "completed", "done");
			const resolved = registry.resolve("a1")!;
			assert.equal(resolved.status, "completed");
			assert.equal(resolved.result, "done");
		});

		it("transitions from running to failed", () => {
			registry.register(makeAgent({ id: "a1" }));
			registry.updateStatus("a1", "failed", "error occurred");
			assert.equal(registry.resolve("a1")!.status, "failed");
			assert.equal(registry.resolve("a1")!.result, "error occurred");
		});

		it("sets endTime on non-running status", () => {
			const agent = makeAgent({ id: "a1" });
			registry.register(agent);
			assert.equal(agent.endTime, undefined);
			registry.updateStatus("a1", "completed");
			assert.ok(agent.endTime! > 0);
		});

		it("no-ops for unknown id", () => {
			// Should not throw
			registry.updateStatus("nonexistent", "completed");
		});
	});

	describe("getRunning", () => {
		it("returns only running agents", () => {
			registry.register(makeAgent({ id: "a1" }));
			registry.register(makeAgent({ id: "a2" }));
			registry.register(makeAgent({ id: "a3" }));
			registry.updateStatus("a2", "completed");
			const running = registry.getRunning();
			assert.equal(running.length, 2);
			assert.ok(running.every((a) => a.status === "running"));
		});

		it("returns empty array when no agents running", () => {
			registry.register(makeAgent({ id: "a1" }));
			registry.updateStatus("a1", "failed");
			assert.equal(registry.getRunning().length, 0);
		});
	});

	describe("getAll", () => {
		it("returns all agents regardless of status", () => {
			registry.register(makeAgent({ id: "a1" }));
			registry.register(makeAgent({ id: "a2" }));
			registry.updateStatus("a2", "completed");
			assert.equal(registry.getAll().length, 2);
		});
	});

	describe("remove", () => {
		it("removes agent from both maps", () => {
			registry.register(makeAgent({ id: "a1", name: "scout" }));
			registry.remove("a1");
			assert.equal(registry.resolve("a1"), undefined);
			assert.equal(registry.resolve("scout"), undefined);
		});

		it("no-ops for unknown id", () => {
			registry.remove("nonexistent"); // should not throw
		});

		it("does not remove name index if another agent claimed the name", () => {
			registry.register(makeAgent({ id: "a1", name: "worker" }));
			registry.updateStatus("a1", "completed");
			registry.register(makeAgent({ id: "a2", name: "worker" }));
			registry.remove("a1");
			// a2 should still be resolvable by name
			assert.ok(registry.resolve("worker"));
			assert.equal(registry.resolve("worker")!.id, "a2");
		});
	});

	describe("stopAll", () => {
		it("stops all running agents", () => {
			registry.register(makeAgent({ id: "a1" }));
			registry.register(makeAgent({ id: "a2" }));
			registry.register(makeAgent({ id: "a3" }));
			registry.updateStatus("a3", "completed");
			registry.stopAll();
			const all = registry.getAll();
			assert.equal(all.filter((a) => a.status === "stopped").length, 2);
			assert.equal(all.filter((a) => a.status === "completed").length, 1);
		});
	});

	describe("getNames", () => {
		it("returns named agents with status", () => {
			registry.register(makeAgent({ id: "a1", name: "scout" }));
			registry.register(makeAgent({ id: "a2", name: "builder" }));
			registry.updateStatus("a2", "completed");
			const names = registry.getNames();
			assert.equal(names.length, 2);
			assert.ok(names.some((n) => n.includes("scout") && n.includes("running")));
			assert.ok(names.some((n) => n.includes("builder") && n.includes("completed")));
		});
	});

	describe("timeout sweeper", () => {
		it("stops overdue agents", async () => {
			const timedOut: string[] = [];
			registry.register(makeAgent({ id: "a1", startTime: Date.now() - 10_000 }));
			registry.register(makeAgent({ id: "a2", startTime: Date.now() }));
			registry.startTimeoutSweeper(5_000, 50, (agent) => timedOut.push(agent.id));

			// Wait for sweeper to fire
			await new Promise((r) => setTimeout(r, 100));
			registry.stopTimeoutSweeper();

			assert.equal(registry.resolve("a1")!.status, "timed_out");
			assert.equal(registry.resolve("a2")!.status, "running");
			assert.deepEqual(timedOut, ["a1"]);
		});

		it("dispose cleans up sweeper", () => {
			registry.startTimeoutSweeper(1000, 50);
			registry.dispose();
			// No assertion needed — just verify no error / interval leak
		});
	});
});
