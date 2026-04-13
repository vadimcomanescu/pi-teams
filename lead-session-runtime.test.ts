import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startLeadSessionRuntime } from "./lead-session-runtime.ts";

describe("startLeadSessionRuntime", () => {
	it("starts every lead-session service, including timeout enforcement", () => {
		const calls: string[] = [];
		startLeadSessionRuntime({
			bootstrapTeamManager() {
				calls.push("bootstrap");
			},
			runStartupOrphanCleanup() {
				calls.push("cleanup");
			},
			startTeamInboxPoller() {
				calls.push("poller");
			},
			scheduleTeammateWidgetRender(kind) {
				calls.push(`widget:${kind}`);
			},
			startTimeoutSweeper() {
				calls.push("timeout");
			},
		});

		assert.deepEqual(calls, ["bootstrap", "cleanup", "poller", "widget:state", "timeout"]);
	});
});
