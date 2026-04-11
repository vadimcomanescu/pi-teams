import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const SCRIPT = path.resolve(process.cwd(), "scripts/enforce-release-publish.mjs");

describe("release publish guard", () => {
	it("blocks direct publish when release flag is absent", () => {
		const result = spawnSync(process.execPath, [SCRIPT], {
			encoding: "utf8",
			env: { ...process.env, PI_TEAMS_RELEASE_SCRIPT: "" },
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Direct npm publish is blocked/);
	});

	it("allows publish when release flag is present", () => {
		const result = spawnSync(process.execPath, [SCRIPT], {
			encoding: "utf8",
			env: { ...process.env, PI_TEAMS_RELEASE_SCRIPT: "1" },
		});
		assert.equal(result.status, 0);
	});
});
