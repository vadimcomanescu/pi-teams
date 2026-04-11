import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFunAgentAlias, getAgentDisplayName } from "./agent-display-name.ts";

describe("agent display names", () => {
	it("uses explicit teammate name when present", () => {
		assert.equal(
			getAgentDisplayName({ id: "abc123", agent: "worker", name: "rocket-raccoon" }),
			"rocket-raccoon",
		);
	});

	it("keeps non-generic agent labels unchanged", () => {
		assert.equal(getAgentDisplayName({ id: "abc123", agent: "scout" }), "scout");
	});

	it("uses deterministic fun alias for generic worker labels", () => {
		const first = getAgentDisplayName({ id: "run-123", agent: "worker" });
		const second = getAgentDisplayName({ id: "run-123", agent: "worker" });
		assert.equal(first, second);
		assert.notEqual(first, "worker");
		assert.match(first, /^[a-z]+-[a-z]+$/);
	});

	it("falls back to unknown when nothing is provided", () => {
		assert.equal(getAgentDisplayName({}), "unknown");
	});

	it("hashes seed into stable adjective-noun pair", () => {
		assert.equal(createFunAgentAlias("seed-1"), createFunAgentAlias("seed-1"));
		assert.notEqual(createFunAgentAlias("seed-1"), createFunAgentAlias("seed-2"));
	});
});
