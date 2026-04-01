import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AGENTS_MANAGER_SHORTCUT_KEY,
	RESERVED_SHORTCUT_KEYS,
} from "./shortcut-contract.js";

const SLASH_RESULT_TYPE = "team-slash-result";
const SLASH_TEAM_REQUEST_EVENT = "team:slash:request";
const SLASH_TEAM_STARTED_EVENT = "team:slash:started";
const SLASH_TEAM_RESPONSE_EVENT = "team:slash:response";

interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

interface RegisterSlashCommandsModule {
	registerSlashCommands?: (
		pi: {
			events: EventBus;
			registerCommand(
				name: string,
				spec: { handler(args: string, ctx: unknown): Promise<void>; getArgumentCompletions?: (prefix: string) => unknown },
			): void;
			registerShortcut(key: string, spec: { handler(ctx: unknown): Promise<void> }): void;
			sendMessage(message: unknown): void;
		},
		state: {
			baseCwd: string;
			currentSessionId: string | null;
			asyncJobs: Map<string, unknown>;
			cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
			lastUiContext: unknown;
			poller: NodeJS.Timeout | null;
			completionSeen: Map<string, number>;
			watcher: unknown;
			watcherRestartTimer: ReturnType<typeof setTimeout> | null;
			resultFileCoalescer: { schedule(file: string, delayMs?: number): boolean; clear(): void };
		},
		deps?: unknown,
	) => void;
}

let registerSlashCommands: RegisterSlashCommandsModule["registerSlashCommands"];
let setCoordinatorMode: ((active: boolean) => void) | undefined;
let available = true;
try {
	({ registerSlashCommands } = await import("./slash-commands.ts") as RegisterSlashCommandsModule);
	({ setCoordinatorMode } = await import("./coordinator.ts") as { setCoordinatorMode?: (active: boolean) => void });
} catch {
	available = false;
}

function createEventBus(): EventBus {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		on(event, handler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
			return () => {
				const current = handlers.get(event) ?? [];
				handlers.set(event, current.filter((entry) => entry !== handler));
			};
		},
		emit(event, data) {
			for (const handler of handlers.get(event) ?? []) {
				handler(data);
			}
		},
	};
}

function createState(cwd: string) {
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

function createCommandContext() {
	return {
		cwd: process.cwd(),
		hasUI: false,
		ui: {
			notify: (_message: string) => {},
			setStatus: (_key: string, _text: string | undefined) => {},
			onTerminalInput: () => () => {},
			custom: async () => undefined,
		},
		modelRegistry: { getAvailable: () => [] },
	};
}

describe("slash command custom message delivery", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	it("registers the shared non-conflicting Agents Manager shortcut", () => {
		const shortcuts: string[] = [];
		const pi = {
			events: createEventBus(),
			registerCommand() {},
			registerShortcut(key: string) {
				shortcuts.push(key);
			},
			sendMessage() {},
		};

		registerSlashCommands!(pi, createState(process.cwd()));

		assert.deepEqual(shortcuts, [AGENTS_MANAGER_SHORTCUT_KEY]);
		for (const reserved of RESERVED_SHORTCUT_KEYS) {
			assert.ok(!shortcuts.includes(reserved), `${reserved} should stay reserved for other extensions`);
		}
	});

	it("/run sends an inline slash result message after a successful bridge response", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_TEAM_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_TEAM_STARTED_EVENT, { requestId });
			events.emit(SLASH_TEAM_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Scout finished" }],
					details: { mode: "single", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout inspect this", createCommandContext());

		// First message: initial progress (display: true)
		// Second message: final result (display: false)
		assert.equal(sent.length, 2, "should send initial + final messages");
		const final = sent[1] as { customType: string; content: string; display: boolean };
		assert.equal(final.customType, SLASH_RESULT_TYPE);
		assert.equal(final.content, "Scout finished");
		assert.equal(final.display, false);
	});

	it("/run still sends an inline slash result message when the bridge returns an error", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_TEAM_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_TEAM_STARTED_EVENT, { requestId });
			events.emit(SLASH_TEAM_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Team failed" }],
					details: { mode: "single", results: [] },
				},
				isError: true,
				errorText: "Team failed",
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout inspect this", createCommandContext());

		// First message: initial progress (display: true)
		// Second message: final error result (display: false)
		assert.equal(sent.length, 2, "should send initial + final messages");
		const final = sent[1] as { customType: string; content: string; display: boolean };
		assert.equal(final.customType, SLASH_RESULT_TYPE);
		assert.equal(final.content, "Team failed");
		assert.equal(final.display, false);
	});

	it("/team shows the active team, shared tasks, and teammate continuation state in lead sessions", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const pi = {
			events: createEventBus(),
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};
		setCoordinatorMode?.(true);
		registerSlashCommands!(pi, createState(process.cwd()), {
			registry: {
				resolve: (id: string) => id === "a1"
					? {
						id: "a1",
						name: "architecture",
						status: "completed",
						sessionFile: "/tmp/architecture.jsonl",
						result: "Architecture review completed",
					}
					: undefined,
			} as unknown,
			teamManager: {
				getActiveTeam: () => ({
					name: "repo-review",
					description: "Review the repository",
					defaultModel: "anthropic/claude-haiku-4-5",
					state: "active",
					members: [
						{
							name: "architecture",
							agentId: "a1",
							agentType: "worker",
							status: "running",
							updatedAt: Date.now(),
						},
					],
				}),
				getTeam: () => undefined,
			},
			createTaskStore: () => ({
				listTasks: () => [{
					id: "task-1234",
					subject: "Architecture review",
					description: "Assess boundaries",
					status: "pending",
					owner: "architecture",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					version: 1,
				}],
			}) as unknown,
		});

		await commands.get("team")!.handler("", createCommandContext());
		setCoordinatorMode?.(false);

		assert.equal(sent.length, 1, "should emit one team overview message");
		const message = sent[0] as { content: string; display: boolean };
		assert.equal(message.display, true);
		assert.match(message.content, /\*\*Team:\*\* repo-review \[active\]/);
		assert.match(message.content, /\*\*Teammates\*\*/);
		assert.match(message.content, /architecture \[completed\].*continuation=resume/);
		assert.match(message.content, /Architecture review completed/);
		assert.match(message.content, /\*\*Tasks\*\*/);
		assert.match(message.content, /task-1234 \[pending\] owner=architecture Architecture review/);
	});

	it("/workers lists only running workers", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const pi = {
			events: createEventBus(),
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};
		setCoordinatorMode?.(true);
		registerSlashCommands!(pi, createState(process.cwd()), {
			registry: {
				getRunning: () => [
					{ id: "run-1", name: "architecture", status: "running", startTime: Date.now() - 1000 },
				],
				getAll: () => [
					{ id: "run-1", name: "architecture", status: "running", startTime: Date.now() - 1000 },
					{ id: "done-1", name: "docs", status: "completed", startTime: Date.now() - 2000 },
				],
			},
		});

		await commands.get("workers")!.handler("", createCommandContext());
		setCoordinatorMode?.(false);

		assert.equal(sent.length, 1, "should emit one workers message");
		const message = sent[0] as { content: string; display: boolean };
		assert.equal(message.display, true);
		assert.match(message.content, /architecture/);
		assert.doesNotMatch(message.content, /docs/);
		assert.doesNotMatch(message.content, /completed/);
	});
});
