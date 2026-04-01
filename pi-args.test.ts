import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPiArgs } from "./pi-args.ts";

describe("buildPiArgs RPC mode", () => {
	it("skips task arg when skipTaskArg is true", () => {
		const { args } = buildPiArgs({
			baseArgs: ["--mode", "rpc"],
			task: "investigate the auth bug",
			skipTaskArg: true,
			sessionEnabled: false,
		});

		// Should NOT contain the task text or -p flag
		const joined = args.join(" ");
		assert.ok(!joined.includes("investigate the auth bug"), "task should not be in args");
		assert.ok(!args.includes("-p"), "-p flag should not be present");
		// Should contain RPC mode args
		assert.ok(args.includes("--mode"));
		assert.ok(args.includes("rpc"));
		// --no-session added by buildPiArgs when sessionEnabled=false (not in baseArgs)
		assert.ok(args.includes("--no-session"));
		// Verify no duplicates
		assert.equal(args.filter((a) => a === "--no-session").length, 1, "--no-session should appear exactly once");
	});

	it("still includes model and other args in RPC mode", () => {
		const { args } = buildPiArgs({
			baseArgs: ["--mode", "rpc"],
			task: "do something",
			skipTaskArg: true,
			sessionEnabled: false,
			model: "claude-sonnet-4-6",
		});

		assert.ok(args.includes("--models"));
		assert.ok(args.includes("claude-sonnet-4-6"));
	});

	it("includes task arg by default (json mode)", () => {
		const { args } = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task: "hello world",
			sessionEnabled: false,
		});

		const joined = args.join(" ");
		assert.ok(joined.includes("hello world"), "task should be in args for json mode");
	});
});

describe("buildPiArgs session wiring", () => {
	it("uses --session when sessionFile is provided", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: true,
			sessionFile: "/tmp/forked-session.jsonl",
			sessionDir: "/tmp/should-not-be-used",
		});

		assert.ok(args.includes("--session"));
		assert.ok(args.includes("/tmp/forked-session.jsonl"));
		assert.ok(!args.includes("--session-dir"), "--session-dir should not be emitted with --session");
		assert.ok(!args.includes("--no-session"), "--no-session should not be emitted with --session");
	});

	it("keeps fresh mode behavior (sessionDir + no session file)", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: true,
			sessionDir: "/tmp/team-sessions",
		});

		assert.ok(args.includes("--session-dir"));
		assert.ok(args.includes("/tmp/team-sessions"));
		assert.ok(!args.includes("--session"));
	});
});
