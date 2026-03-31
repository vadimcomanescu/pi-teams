/**
 * Integration tests for RPC mode agent spawning.
 *
 * Tests the full spawn→stdin prompt→NDJSON parse→result pipeline
 * using createMockPi() from @marcfargas/pi-test-harness.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import type { MockPi } from "./helpers.ts";
import {
	createMockPi,
	createTempDir,
	removeTempDir,
	makeAgentConfigs,
	events,
	tryImport,
} from "./helpers.ts";

const execution = await tryImport<any>("./execution.ts");
const utils = await tryImport<any>("./utils.ts");
const available = !!(execution && utils);

const runSync = execution?.runSync;
const getFinalOutput = utils?.getFinalOutput;

describe("RPC mode spawning", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	it("RPC mode sends prompt via stdin and parses NDJSON output", async () => {
		mockPi.onCall({ output: "RPC response" });
		const agents = makeAgentConfigs(["worker"]);

		const result = await runSync(tempDir, agents, "worker", "Investigate the auth bug", {
			spawnMode: "rpc",
		});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.equal(output, "RPC response");
	});

	it("RPC mode captures usage from message events", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["worker"]);

		const result = await runSync(tempDir, agents, "worker", "Task", {
			spawnMode: "rpc",
		});

		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 100);
		assert.equal(result.usage.output, 50);
	});

	it("RPC mode handles multi-turn JSONL conversation", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("bash", { command: "ls" }),
				events.toolEnd("bash"),
				events.toolResult("bash", "file1.ts\nfile2.ts"),
				events.assistantMessage("Found 2 files"),
			],
		});
		const agents = makeAgentConfigs(["researcher"]);

		const result = await runSync(tempDir, agents, "researcher", "List files", {
			spawnMode: "rpc",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress!.toolCount, 1);
		const output = getFinalOutput(result.messages);
		assert.ok(output.includes("Found 2 files"));
	});

	it("RPC mode captures non-zero exit code", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Worker crashed" });
		const agents = makeAgentConfigs(["worker"]);

		const result = await runSync(tempDir, agents, "worker", "Do something", {
			spawnMode: "rpc",
		});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Worker crashed"));
	});

	it("onSpawn callback fires with live process before completion", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["worker"]);

		let spawnedProc: ChildProcess | undefined;
		let spawnedPid: number | undefined;

		const result = await runSync(tempDir, agents, "worker", "Task", {
			spawnMode: "rpc",
			onSpawn: (proc: ChildProcess) => {
				spawnedProc = proc;
				spawnedPid = proc.pid;
				// At this point the process should be alive (pid assigned)
				assert.ok(proc.pid, "process should have a pid when onSpawn fires");
				assert.ok(proc.stdin, "process should have stdin piped");
			},
		});

		assert.ok(spawnedProc, "onSpawn should have been called");
		assert.ok(spawnedPid! > 0, "should have a valid pid");
		assert.equal(result.exitCode, 0);
	});

	it("onSpawn does NOT fire in default json mode", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["worker"]);

		let spawnCalled = false;

		await runSync(tempDir, agents, "worker", "Task", {
			onSpawn: () => { spawnCalled = true; },
		});

		assert.equal(spawnCalled, false, "onSpawn should not fire in json mode");
	});

	it("onExit callback fires with exit code", async () => {
		mockPi.onCall({ exitCode: 42 });
		const agents = makeAgentConfigs(["worker"]);

		let exitCode: number | undefined;

		await runSync(tempDir, agents, "worker", "Task", {
			spawnMode: "rpc",
			onExit: (code: number) => { exitCode = code; },
		});

		assert.equal(exitCode, 42);
	});

	it("rpcProc is set on result in RPC mode", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["worker"]);

		const result = await runSync(tempDir, agents, "worker", "Task", {
			spawnMode: "rpc",
		});

		assert.ok(result.rpcProc, "rpcProc should be set on result");
	});

	it("rpcProc is NOT set in default json mode", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["worker"]);

		const result = await runSync(tempDir, agents, "worker", "Task", {});

		assert.equal(result.rpcProc, undefined, "rpcProc should not be set in json mode");
	});

	it("default mode remains json (backwards compatible)", async () => {
		mockPi.onCall({ output: "Hello" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Say hello", {});

		assert.equal(result.exitCode, 0);
		assert.equal(getFinalOutput(result.messages), "Hello");
		assert.equal(result.rpcProc, undefined);
	});
});
