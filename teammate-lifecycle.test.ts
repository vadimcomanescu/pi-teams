import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeTeammateLifecycle } from "./teammate-lifecycle.ts";

describe("describeTeammateLifecycle", () => {
	it("treats a running RPC teammate as directly addressable", () => {
		const lifecycle = describeTeammateLifecycle({
			status: "running",
			acceptsFollowUps: true,
			sessionFile: "/tmp/team.jsonl",
		});
		assert.deepEqual(lifecycle, {
			activity: "running",
			addressable: true,
			canQueueFollowUp: true,
			canResume: false,
			continuationText: "send_message will queue a follow-up immediately",
		});
	});

	it("marks a running non-addressable worker as not directly addressable", () => {
		const lifecycle = describeTeammateLifecycle({ status: "running", acceptsFollowUps: false });
		assert.equal(lifecycle.activity, "running");
		assert.equal(lifecycle.addressable, false);
		assert.equal(lifecycle.canQueueFollowUp, false);
		assert.match(lifecycle.continuationText, /without a follow-up channel/i);
	});

	it("treats a live teammate waiting for follow-up as idle but still directly addressable", () => {
		const lifecycle = describeTeammateLifecycle({
			status: "running",
			acceptsFollowUps: true,
			sessionFile: "/tmp/team.jsonl",
			isActive: false,
		});
		assert.equal(lifecycle.activity, "idle");
		assert.equal(lifecycle.addressable, true);
		assert.equal(lifecycle.canQueueFollowUp, true);
		assert.equal(lifecycle.canResume, false);
		assert.match(lifecycle.continuationText, /queue a follow-up immediately/i);
	});

	it("treats an idle teammate with a session as resumable", () => {
		const lifecycle = describeTeammateLifecycle({ status: "completed", sessionFile: "/tmp/team.jsonl" });
		assert.equal(lifecycle.activity, "idle");
		assert.equal(lifecycle.addressable, true);
		assert.equal(lifecycle.canResume, true);
		assert.match(lifecycle.continuationText, /resume this teammate/i);
	});

	it("treats an idle teammate without a session as non-addressable", () => {
		const lifecycle = describeTeammateLifecycle({ status: "stopped" });
		assert.equal(lifecycle.activity, "idle");
		assert.equal(lifecycle.addressable, false);
		assert.equal(lifecycle.canResume, false);
		assert.match(lifecycle.continuationText, /spawn a fresh teammate/i);
	});

	it("treats inactive teams as non-addressable even if a session exists", () => {
		const lifecycle = describeTeammateLifecycle({
			status: "completed",
			sessionFile: "/tmp/team.jsonl",
			active: false,
		});
		assert.equal(lifecycle.activity, "idle");
		assert.equal(lifecycle.addressable, false);
		assert.equal(lifecycle.canResume, false);
		assert.match(lifecycle.continuationText, /not active/i);
	});

	it("treats a running teammate in a shutdown team as idle and non-addressable", () => {
		const lifecycle = describeTeammateLifecycle({
			status: "running",
			acceptsFollowUps: true,
			sessionFile: "/tmp/team.jsonl",
			active: false,
			isActive: true,
		});
		assert.equal(lifecycle.activity, "idle");
		assert.equal(lifecycle.addressable, false);
		assert.equal(lifecycle.canQueueFollowUp, false);
		assert.equal(lifecycle.canResume, false);
		assert.match(lifecycle.continuationText, /not active/i);
	});
});
