import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTeammateSurfaceState } from "./teammate-surface-state.ts";

describe("resolveTeammateSurfaceState", () => {
	it("prefers live recent output over stale goal summaries for running teammates", () => {
		const surface = resolveTeammateSurfaceState({
			team: {
				name: "review",
				state: "active",
				members: [],
				leadSessionId: "s1",
				createdAt: 1,
			} as never,
			member: {
				name: "docs",
				agentId: "a1",
				agentType: "worker",
				status: "running",
				cwd: "/tmp",
				lastSummary: "Review docs",
				isActive: true,
				updatedAt: 1,
			} as never,
			live: {
				id: "a1",
				agentType: "worker",
				status: "running",
				task: "Review docs",
				result: "Review docs",
				recentOutput: ["Scanning README section", "Patched install docs"],
				currentTool: "edit README.md",
				startTime: 1,
			} as never,
		});

		assert.equal(surface.summary, "Patched install docs");
	});

	it("uses operator-facing availability copy without raw tool syntax", () => {
		const running = resolveTeammateSurfaceState({
			team: { name: "review", state: "active", members: [], leadSessionId: "s1", createdAt: 1 } as never,
			member: { name: "docs", agentId: "a1", agentType: "worker", status: "running", cwd: "/tmp", isActive: true, updatedAt: 1 } as never,
			checked: {
				status: "running",
				mode: "default",
				teamName: "review",
				member: {} as never,
				state: "active",
				lifecycle: {
					activity: "running",
					addressable: true,
					canQueueFollowUp: true,
					canResume: false,
					continuationText: "send_message will queue a follow-up immediately",
				},
			} as never,
		});
		const idle = resolveTeammateSurfaceState({
			team: { name: "review", state: "active", members: [], leadSessionId: "s1", createdAt: 1 } as never,
			member: { name: "docs", agentId: "a1", agentType: "worker", status: "completed", cwd: "/tmp", isActive: false, updatedAt: 1 } as never,
			checked: {
				status: "completed",
				mode: "default",
				teamName: "review",
				member: {} as never,
				state: "active",
				lifecycle: {
					activity: "idle",
					addressable: true,
					canQueueFollowUp: false,
					canResume: true,
					continuationText: "send_message can resume this teammate",
				},
			} as never,
		});

		assert.equal(running.availabilityText, "Running now and can take follow-up work");
		assert.equal(idle.availabilityText, "Idle, can be resumed");
		assert.doesNotMatch(`${running.availabilityText} ${idle.availabilityText}`, /send_message|worker/i);
	});
});
