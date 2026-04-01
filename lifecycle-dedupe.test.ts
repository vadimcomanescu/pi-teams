import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLifecycleDedupe } from "./lifecycle-dedupe.ts";

describe("createLifecycleDedupe", () => {
	it("suppresses duplicate lifecycle keys within ttl", () => {
		const dedupe = createLifecycleDedupe(50);
		assert.equal(dedupe.shouldProcess("started:abc"), true);
		assert.equal(dedupe.shouldProcess("started:abc"), false);
		assert.equal(dedupe.shouldProcess("complete:abc:completed"), true);
		assert.equal(dedupe.shouldProcess("complete:abc:completed"), false);
	});

	it("allows different lifecycle keys for the same agent", () => {
		const dedupe = createLifecycleDedupe(50);
		assert.equal(dedupe.shouldProcess("complete:abc:stopped"), true);
		assert.equal(dedupe.shouldProcess("complete:abc:failed"), true);
	});
});
