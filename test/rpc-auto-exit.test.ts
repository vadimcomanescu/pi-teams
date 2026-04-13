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
const utils = await tryImport<any>("./utils.ts");
const available = !!(execution && utils);
const runSync = execution?.runSync;
const getFinalOutput = utils?.getFinalOutput;

function installRpcFinalResponseHangShim(tempDir: string): () => void {
	const scriptPath = path.join(tempDir, "rpc-hang-after-final.mjs");
	const jsonLines = [
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: "bash", arguments: { command: "echo hello" } }],
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.3-codex",
				stopReason: "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		},
		{
			type: "tool_result_end",
			message: {
				role: "toolResult",
				toolName: "bash",
				content: [{ type: "text", text: "hello" }],
				isError: false,
			},
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "all done" }],
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.3-codex",
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		},
	];
	fs.writeFileSync(
		scriptPath,
		`${jsonLines.map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`).join("\n")}\nsetTimeout(() => process.exit(0), 10000);\n`,
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

function installRpcRejectedShutdownShim(tempDir: string): () => void {
	const scriptPath = path.join(tempDir, "rpc-rejected-shutdown.mjs");
	const jsonLines = [
		{ type: "teammate_control_message", message: { type: "shutdown_response", requestId: "req-1", approve: false, reason: "still working" } },
		{
			type: "tool_execution_start",
			toolName: "send_message",
			args: { to: "lead", message: { type: "shutdown_response", request_id: "req-1", approve: false, reason: "still working" } },
		},
		{ type: "tool_execution_end", toolName: "send_message" },
		{
			type: "tool_result_end",
			message: {
				role: "toolResult",
				toolName: "send_message",
				content: [{ type: "text", text: "Sent graceful shutdown rejection to the lead: still working" }],
				isError: false,
			},
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "rejection sent" }],
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.3-codex",
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		},
	];
	fs.writeFileSync(
		scriptPath,
		`${jsonLines.map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`).join("\n")}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split(/\\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "abort") process.exit(0);
    } catch {}
  }
});
setTimeout(() => process.exit(0), 3500);
`,
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

describe("RPC one-shot teammate mode", { skip: !available ? "execution.ts not importable" : undefined }, () => {
	let tempDir = "";
	let restoreShim: (() => void) | undefined;

	afterEach(() => {
		restoreShim?.();
		restoreShim = undefined;
		if (tempDir) removeTempDir(tempDir);
		tempDir = "";
	});

	it("exits quickly after final assistant response when requested", async () => {
		tempDir = createTempDir("pi-team-rpc-auto-exit-");
		restoreShim = installRpcFinalResponseHangShim(tempDir);
		const agents = makeAgentConfigs(["worker"]);

		const startedAt = Date.now();
		const result = await runSync(tempDir, agents, "worker", "Say hello", {
			spawnMode: "rpc",
			exitAfterFinalAssistantMessage: true,
			runId: "rpc-auto-exit",
		});
		const durationMs = Date.now() - startedAt;

		assert.equal(result.exitCode, 0);
		assert.equal(getFinalOutput(result.messages), "all done");
		assert.ok(durationMs < 5_000, `expected auto-exit within 5s, got ${durationMs}ms`);
	});

	it("does not auto-exit after a rejected shutdown response and forwards the control message", async () => {
		tempDir = createTempDir("pi-team-rpc-shutdown-reject-");
		restoreShim = installRpcRejectedShutdownShim(tempDir);
		const agents = makeAgentConfigs(["worker"]);
		const controlMessages: unknown[] = [];
		const idleSummaries: string[] = [];

		const startedAt = Date.now();
		const result = await runSync(tempDir, agents, "worker", "Respond to shutdown", {
			spawnMode: "rpc",
			exitAfterFinalAssistantMessage: true,
			runId: "rpc-shutdown-reject",
			onTeammateControlMessage: (message) => {
				controlMessages.push(message);
			},
			onTeammateIdle: (summary) => {
				if (summary) idleSummaries.push(summary);
			},
		});
		const durationMs = Date.now() - startedAt;

		assert.equal(result.exitCode, 0);
		assert.equal(getFinalOutput(result.messages), "rejection sent");
		assert.deepEqual(controlMessages, [{ type: "shutdown_response", requestId: "req-1", approve: false, reason: "still working" }]);
		assert.deepEqual(idleSummaries, []);
		assert.ok(durationMs >= 3_000, `expected rejected shutdown to keep teammate alive, got ${durationMs}ms`);
	});
});
