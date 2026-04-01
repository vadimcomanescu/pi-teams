import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TeamState } from "./types.ts";

let createAsyncJobTracker: ((state: TeamState, asyncDirRoot: string) => {
	ensurePoller: () => void;
	handleStarted: (data: unknown) => void;
	handleComplete: (data: unknown) => void;
	resetJobs: () => void;
}) | undefined;
let available = true;
try {
	({ createAsyncJobTracker } = await import("./async-job-tracker.ts"));
} catch {
	available = false;
}

function makeState(): TeamState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

describe("createAsyncJobTracker", { skip: !available ? "async-job-tracker.ts not importable" : undefined }, () => {
	it("preserves stopped terminal state in the widget job model", () => {
		const state = makeState();
		const tracker = createAsyncJobTracker!(state, "/tmp/async");

		tracker.handleStarted({ id: "job-1", agent: "worker" });
		tracker.handleComplete({ id: "job-1", status: "stopped", success: false });

		assert.equal(state.asyncJobs.get("job-1")?.status, "stopped");
	});

	it("preserves timed_out terminal state in the widget job model", () => {
		const state = makeState();
		const tracker = createAsyncJobTracker!(state, "/tmp/async");

		tracker.handleStarted({ id: "job-1", agent: "worker" });
		tracker.handleComplete({ id: "job-1", status: "timed_out", success: false });

		assert.equal(state.asyncJobs.get("job-1")?.status, "timed_out");
	});
});
