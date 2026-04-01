import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { MockPi } from "./helpers.ts";
import { createMockPi, createTempDir, removeTempDir, tryImport } from "./helpers.ts";

interface ExecutorModule {
	createTeamExecutor?: (...args: unknown[]) => {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: ((result: unknown) => void) | undefined,
			ctx: unknown,
		) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
	};
}

const executorMod = await tryImport<ExecutorModule>("./team-executor.ts");
const available = !!executorMod;
const createTeamExecutor = executorMod?.createTeamExecutor;

interface SessionStubOptions {
	sessionFile?: string;
	leafId?: string | null;
}

interface SessionManagerStub {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	createBranchedSession(leafId: string): string;
}

function makeSessionManagerRecorder(options: SessionStubOptions = {}) {
	const calls: string[] = [];
	let counter = 0;
	const manager: SessionManagerStub = {
		getSessionFile: () => options.sessionFile,
		getLeafId: () => (options.leafId === undefined ? "leaf-current" : options.leafId),
		createBranchedSession: (leafId: string) => {
			calls.push(leafId);
			counter++;
			return `/tmp/team-fork-${counter}.jsonl`;
		},
	};
	return { manager, calls };
}

function makeState(cwd: string) {
	return {
		baseCwd: cwd,
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

describe("fork context execution wiring", { skip: !available ? "team executor not importable" : undefined }, () => {
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
		tempDir = createTempDir("pi-team-fork-test-");
		mockPi.reset();
		mockPi.onCall({ output: "ok" });
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeExecutor() {
		return createTeamExecutor({
			pi: { events: { emit: () => {} } },
			state: makeState(tempDir),
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getTeamSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({
				agents: [
					{ name: "echo", description: "Echo test agent" },
					{ name: "second", description: "Second test agent" },
				],
			}),
		});
	}

	function makeCtx(sessionManager: SessionManagerStub) {
		return {
			cwd: tempDir,
			hasUI: false,
			ui: {},
			modelRegistry: { getAvailable: () => [] },
			sessionManager,
		};
	}

	it("fails fast when context=fork and parent session is missing", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: undefined, leafId: "leaf-current" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "test", context: "fork" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /persisted parent session/);
	});

	it("fails fast when context=fork and leaf is missing", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: "/tmp/parent.jsonl", leafId: null });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "test", context: "fork" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /current leaf/);
	});

	it("returns a tool error (instead of throwing) when branch creation fails", async () => {
		const executor = makeExecutor();
		const manager = {
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-fail",
			createBranchedSession: () => {
				throw new Error("branch write failed");
			},
		};

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "test", context: "fork" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to create forked team session/);
		assert.match(result.content[0]?.text ?? "", /branch write failed/);
	});

	it("creates one forked session for single mode", async () => {
		const { manager, calls } = makeSessionManagerRecorder({ sessionFile: "/tmp/parent.jsonl", leafId: "leaf-123" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "single task", context: "fork" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls, ["leaf-123"]);
	});

	it("creates isolated forked sessions per parallel task", async () => {
		const { manager, calls } = makeSessionManagerRecorder({ sessionFile: "/tmp/parent.jsonl", leafId: "leaf-777" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				tasks: [
					{ agent: "echo", task: "task one" },
					{ agent: "second", task: "task two" },
				],
				context: "fork",
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(calls.length, 2);
		assert.deepEqual(calls, ["leaf-777", "leaf-777"]);
	});

	it("creates isolated forked sessions per chain step (including parallel steps)", async () => {
		const { manager, calls } = makeSessionManagerRecorder({ sessionFile: "/tmp/parent.jsonl", leafId: "leaf-chain" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				chain: [
					{ agent: "echo", task: "step 1" },
					{ parallel: [{ agent: "echo", task: "p1" }, { agent: "second", task: "p2" }] },
					{ agent: "second", task: "step 3" },
				],
				context: "fork",
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(calls.length, 4, "1 sequential + 2 parallel + 1 sequential");
		assert.deepEqual(calls, ["leaf-chain", "leaf-chain", "leaf-chain", "leaf-chain"]);
	});
});
