import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLiveWidgetRenderState, clearTeammateWidgets, LEGACY_ASYNC_WIDGET_KEY, TEAMMATE_WIDGET_KEY } from "./teammate-live-widget.ts";

describe("teammate live widget surface", () => {
	it("renders only currently running teammates in the compact live widget", () => {
		const result = buildLiveWidgetRenderState({
			team: {
				name: "repo-review",
				state: "active",
				members: [
					{ name: "docs", agentId: "a1", agentType: "worker", status: "running", updatedAt: 1000, isActive: true, cwd: "/tmp" },
					{ name: "qa", agentId: "a2", agentType: "worker", status: "failed", updatedAt: 1000, isActive: false, cwd: "/tmp" },
					{ name: "ops", agentId: "a3", agentType: "worker", status: "completed", updatedAt: 1000, isActive: false, cwd: "/tmp" },
				],
			} as never,
			checkTeammate(teamName, memberName) {
				assert.equal(teamName, "repo-review");
				if (memberName === "docs") {
					return { status: "running", lastSummary: "Updating docs", lifecycle: { activity: "running" } } as never;
				}
				if (memberName === "qa") {
					return { status: "failed", lastSummary: "Tests failed", lifecycle: { activity: "idle" } } as never;
				}
				return { status: "completed", lastSummary: "Done", lifecycle: { activity: "idle" } } as never;
			},
			resolveAgent(agentId) {
				if (agentId === "a1") {
					return { task: "Update README", currentTool: "edit README.md" } as never;
				}
				return undefined;
			},
			nowMs: 10_000,
			frame: 0,
		});

		assert.equal(result.shouldAnimate, true);
		assert.equal(result.lines?.length, 2);
		assert.match(result.lines?.[1] ?? "", /@docs/);
		assert.doesNotMatch(result.lines?.join("\n") ?? "", /@qa|@ops/);
		assert.ok(result.snapshot?.includes("@docs"));
	});

	it("clears the live widget when no teammates are currently running", () => {
		const result = buildLiveWidgetRenderState({
			team: {
				name: "repo-review",
				state: "active",
				members: [
					{ name: "docs", agentId: "a1", agentType: "worker", status: "completed", updatedAt: 1000, isActive: false, cwd: "/tmp" },
				],
			} as never,
			checkTeammate() {
				return { status: "completed", lifecycle: { activity: "idle" } } as never;
			},
			resolveAgent() {
				return undefined;
			},
			nowMs: 10_000,
			frame: 4,
		});

		assert.equal(result.lines, undefined);
		assert.equal(result.snapshot, null);
		assert.equal(result.shouldAnimate, false);
		assert.equal(result.nextFrame, 4);
	});

	it("keeps idle running teammates visible and skips animation while awaiting approval", () => {
		const result = buildLiveWidgetRenderState({
			team: {
				name: "repo-review",
				state: "active",
				members: [
					{ name: "docs", agentId: "a1", agentType: "worker", status: "running", pendingShutdownRequestId: "req-1", updatedAt: 1000, isActive: false, cwd: "/tmp" },
				],
			} as never,
			checkTeammate() {
				return { status: "running", lastSummary: "Waiting for approval", lifecycle: { activity: "idle" } } as never;
			},
			resolveAgent() {
				return { task: "Finalize review" } as never;
			},
			nowMs: 10_000,
			frame: 2,
		});

		assert.equal(result.shouldAnimate, false);
		assert.match(result.lines?.[1] ?? "", /@docs/);
		assert.match(result.lines?.[1] ?? "", /Awaiting approval/);
	});

	it("surfaces changing live activity as progress updates arrive", () => {
		const baseInput = {
			team: {
				name: "repo-review",
				state: "active",
				members: [
					{ name: "docs", agentId: "a1", agentType: "worker", status: "running", updatedAt: 1000, isActive: true, cwd: "/tmp" },
				],
			} as never,
			checkTeammate() {
				return { status: "running", lastSummary: "Review docs", lifecycle: { activity: "running" } } as never;
			},
			nowMs: 10_000,
		};
		const first = buildLiveWidgetRenderState({
			...baseInput,
			resolveAgent() {
				return { recentOutput: ["Reading README"], startTime: 1 } as never;
			},
			frame: 0,
		});
		const second = buildLiveWidgetRenderState({
			...baseInput,
			resolveAgent() {
				return { recentOutput: ["Patched README"], startTime: 1 } as never;
			},
			frame: 1,
		});

		assert.match(first.lines?.[1] ?? "", /Reading README/);
		assert.match(second.lines?.[1] ?? "", /Patched README/);
		assert.notEqual(first.snapshot, second.snapshot);
	});

	it("falls back to stored member status when checkTeammate fails", () => {
		const result = buildLiveWidgetRenderState({
			team: {
				name: "repo-review",
				state: "active",
				members: [
					{ name: "docs", agentId: "a1", agentType: "worker", status: "running", updatedAt: 1000, isActive: true, cwd: "/tmp" },
				],
			} as never,
			checkTeammate() {
				throw new Error("temporary lookup failure");
			},
			resolveAgent() {
				return { currentTool: "edit README.md" } as never;
			},
			nowMs: 10_000,
			frame: 1,
		});

		assert.equal(result.shouldAnimate, true);
		assert.match(result.lines?.[1] ?? "", /edit README\.md/);
	});

	it("clears both the live and legacy async widget keys together", () => {
		const calls: Array<{ key: string; value: string[] | undefined }> = [];
		clearTeammateWidgets({
			setWidget(key, value) {
				calls.push({ key, value });
			},
		});

		assert.deepEqual(calls, [
			{ key: TEAMMATE_WIDGET_KEY, value: undefined },
			{ key: LEGACY_ASYNC_WIDGET_KEY, value: undefined },
		]);
	});
});
