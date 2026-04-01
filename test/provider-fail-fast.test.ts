import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createTempDir,
	removeTempDir,
	makeAgentConfigs,
	tryImport,
} from "./helpers.ts";

const execution = await tryImport<any>("./execution.ts");
const available = !!execution;
const runSync = execution?.runSync;

function installFatalProviderPiShim(tempDir: string): () => void {
	const scriptPath = path.join(tempDir, "fatal-provider-pi.mjs");
	const errorMessage = "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"}}";
	fs.writeFileSync(
		scriptPath,
		`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "claude-haiku-4-5", stopReason: "error", errorMessage: ${JSON.stringify(errorMessage)} } }));\nsetTimeout(() => process.exit(0), 10000);\n`,
		"utf-8",
	);

	const originalPath = process.env.PATH ?? "";
	const originalArgv1 = process.argv[1];

	if (process.platform === "win32") {
		process.argv[1] = scriptPath;
	} else {
		const shimPath = path.join(tempDir, "pi");
		fs.writeFileSync(shimPath, `#!/bin/sh\nexec \"${process.execPath}\" \"${scriptPath}\" \"$@\"\n`, { mode: 0o755 });
		process.env.PATH = `${tempDir}${path.delimiter}${originalPath}`;
	}

	return () => {
		process.argv[1] = originalArgv1;
		process.env.PATH = originalPath;
	};
}

describe("provider hard-limit fail-fast", { skip: !available ? "execution.ts not importable" : undefined }, () => {
	let tempDir = "";
	let restoreShim: (() => void) | undefined;

	afterEach(() => {
		restoreShim?.();
		restoreShim = undefined;
		if (tempDir) removeTempDir(tempDir);
		tempDir = "";
	});

	it("fails fast instead of waiting for worker timeout on hard provider limits", async () => {
		tempDir = createTempDir("pi-team-provider-limit-");
		restoreShim = installFatalProviderPiShim(tempDir);
		const agents = makeAgentConfigs(["worker"]);

		const startedAt = Date.now();
		const result = await runSync(tempDir, agents, "worker", "Inspect the repo", {});
		const durationMs = Date.now() - startedAt;

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /Provider hard limit/i);
		assert.match(result.error ?? "", /rate limit/i);
		assert.ok(durationMs < 5_000, `expected fail-fast within 5s, got ${durationMs}ms`);
	});
});
