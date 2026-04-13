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
			lastUiContext: unknown;
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
		lastUiContext: null,
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

	it("/team renders roster metadata and teammate state badges in lead sessions", async () => {
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
						task: "Review architecture boundaries",
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
							pendingShutdownRequestId: "req-1",
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

		assert.equal(sent.length, 1, "should emit one team roster message");
		const message = sent[0] as { content: string; display: boolean };
		assert.equal(message.display, true);
		assert.match(message.content, /\*\*Team:\*\* repo-review \[active\]/);
		assert.match(message.content, /1 teammate/);
		assert.match(message.content, /\*\*Roster\*\*/);
		assert.match(message.content, /architecture .*\[completed\]/);
		assert.doesNotMatch(message.content, /[◇▶●◆○]/);
		assert.match(message.content, /Architecture review completed/);
		assert.match(message.content, /\*\*Tasks\*\*/);
		assert.match(message.content, /task-1234 \[pending\] Architecture review \(assigned to @architecture\)/);
		assert.doesNotMatch(message.content, /owner=architecture/);
		assert.doesNotMatch(message.content, /Actions:/);
	});

	it("/team roster prefers live activity over stale task goals", async () => {
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
				resolve: () => ({
					id: "a1",
					name: "docs",
					status: "running",
					result: "Review documentation",
					task: "Review documentation",
					currentTool: "edit README.md",
					recentOutput: ["Patched install docs"],
				}) as unknown,
			} as unknown,
			teamManager: {
				getActiveTeam: () => ({
					name: "repo-review",
					defaultModel: "anthropic/claude-haiku-4-5",
					state: "active",
					members: [{
						name: "docs",
						agentId: "a1",
						agentType: "worker",
						status: "running",
						lastSummary: "Review documentation",
						updatedAt: Date.now(),
					}],
				}),
				getTeam: () => undefined,
				checkTeammate: () => ({
					status: "running",
					mode: "default",
					teamName: "repo-review",
					member: {} as never,
					state: "active",
					lastSummary: "Review documentation",
					lifecycle: {
						activity: "running",
						addressable: true,
						canQueueFollowUp: true,
						canResume: false,
						continuationText: "send_message will queue a follow-up immediately",
					},
				}) as never,
			},
			createTaskStore: () => ({ listTasks: () => [] }) as unknown,
		});

		await commands.get("team")!.handler("", createCommandContext());
		setCoordinatorMode?.(false);

		const message = sent[0] as { content: string };
		assert.match(message.content, /Patched install docs/);
		assert.doesNotMatch(message.content, /\n  Review documentation/);
	});

	it("/team roster skips low-signal summary noise and falls back to meaningful text", async () => {
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
				resolve: () => ({
					id: "a1",
					name: "docs",
					status: "running",
					result: "```json",
					task: "Review documentation",
				}) as unknown,
			} as unknown,
			teamManager: {
				getActiveTeam: () => ({
					name: "repo-review",
					defaultModel: "anthropic/claude-haiku-4-5",
					state: "active",
					members: [{
						name: "docs",
						agentId: "a1",
						agentType: "worker",
						status: "running",
						lastSummary: "Reading docs and preparing patch",
						updatedAt: Date.now(),
					}],
				}),
				getTeam: () => undefined,
			},
			createTaskStore: () => ({ listTasks: () => [] }) as unknown,
		});

		await commands.get("team")!.handler("", createCommandContext());
		setCoordinatorMode?.(false);

		const message = sent[0] as { content: string };
		assert.match(message.content, /Reading docs and preparing patch/);
		assert.doesNotMatch(message.content, /```json/);
	});

	it("/team --detail renders model/cwd, owned tasks, and truncated prompt preview", async () => {
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
				resolve: () => ({
					id: "a1",
					name: "docs",
					status: "running",
					sessionFile: "/tmp/docs.jsonl",
					task: "A".repeat(600),
				}) as unknown,
			} as unknown,
			teamManager: {
				getActiveTeam: () => ({
					name: "repo-review",
					defaultModel: "anthropic/claude-sonnet-4-6",
					state: "active",
					members: [{
						name: "docs",
						agentId: "a1",
						agentType: "worker",
						status: "running",
						cwd: "/tmp/repo",
						updatedAt: Date.now(),
					}],
				}),
				getTeam: () => undefined,
			},
			createTaskStore: () => ({
				listTasks: () => [
					{
						id: "task-1",
						subject: "Draft docs",
						description: "Write docs",
						status: "pending",
						owner: "docs",
						createdAt: Date.now(),
						updatedAt: Date.now(),
						version: 1,
					},
					{
						id: "task-2",
						subject: "Polish docs",
						description: "Polish",
						status: "completed",
						owner: "docs",
						createdAt: Date.now(),
						updatedAt: Date.now(),
						version: 1,
					},
				],
			}) as unknown,
		});

		await commands.get("team")!.handler("--detail docs", createCommandContext());
		setCoordinatorMode?.(false);

		assert.equal(sent.length, 1, "should emit one teammate detail message");
		const message = sent[0] as { content: string; display: boolean };
		assert.equal(message.display, true);
		assert.match(message.content, /\*\*Teammate:\*\* @docs/);
		assert.match(message.content, /Mode: default/);
		assert.doesNotMatch(message.content, /Mode: [◇▶●◆○]/);
		assert.match(message.content, /Model: anthropic\/claude-sonnet-4-6/);
		assert.match(message.content, /CWD: \/tmp\/repo/);
		assert.match(message.content, /\*\*Owned tasks\*\*/);
		assert.match(message.content, /\- \[ \] task-1 Draft docs/);
		assert.match(message.content, /\- \[x\] task-2 Polish docs/);
		assert.match(message.content, /\*\*Latest activity\*\*/);
		assert.match(message.content, /Availability: Running now, but not directly reachable/);
		assert.match(message.content, /Prompt preview truncated/);
		assert.doesNotMatch(message.content, /Continuation:/);
		assert.doesNotMatch(message.content, /send_message|worker is running/i);
		assert.doesNotMatch(message.content, /Actions:/);
		assert.doesNotMatch(message.content, /left=\/team|enter=check_teammate/);
	});

	it("/team --detail --full-prompt shows the complete prompt preview", async () => {
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
				resolve: () => ({
					id: "a1",
					name: "docs",
					status: "running",
					task: "full prompt body",
				}) as unknown,
			} as unknown,
			teamManager: {
				getActiveTeam: () => ({
					name: "repo-review",
					defaultModel: "anthropic/claude-sonnet-4-6",
					state: "active",
					members: [{
						name: "docs",
						agentId: "a1",
						agentType: "worker",
						status: "running",
						cwd: "/tmp/repo",
						updatedAt: Date.now(),
					}],
				}),
				getTeam: () => undefined,
			},
			createTaskStore: () => ({
				listTasks: () => [],
			}) as unknown,
		});

		await commands.get("team")!.handler("--detail docs --full-prompt", createCommandContext());
		setCoordinatorMode?.(false);

		assert.equal(sent.length, 1);
		const message = sent[0] as { content: string };
		assert.match(message.content, /\*\*Prompt preview\*\*/);
		assert.match(message.content, /full prompt body/);
		assert.doesNotMatch(message.content, /Prompt preview truncated/);
	});

	it("/team --detail relabels summary fallback instead of calling it a prompt preview", async () => {
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
				resolve: () => ({
					id: "a1",
					name: "docs",
					status: "completed",
				}) as unknown,
			} as unknown,
			teamManager: {
				getActiveTeam: () => ({
					name: "repo-review",
					defaultModel: "anthropic/claude-sonnet-4-6",
					state: "active",
					members: [{
						name: "docs",
						agentId: "a1",
						agentType: "worker",
						status: "completed",
						cwd: "/tmp/repo",
						lastSummary: "Reviewed the docs and prepared a patch",
						updatedAt: Date.now(),
					}],
				}),
				getTeam: () => undefined,
			},
			createTaskStore: () => ({
				listTasks: () => [],
			}) as unknown,
		});

		await commands.get("team")!.handler("--detail docs", createCommandContext());
		setCoordinatorMode?.(false);

		assert.equal(sent.length, 1);
		const message = sent[0] as { content: string };
		assert.match(message.content, /\*\*Latest summary\*\*/);
		assert.match(message.content, /Reviewed the docs and prepared a patch/);
		assert.doesNotMatch(message.content, /\*\*Prompt preview\*\*/);
		assert.doesNotMatch(message.content, /Prompt preview truncated/);
	});

	it("/team renders a clean No teammates empty state", async () => {
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
			teamManager: {
				getActiveTeam: () => ({
					name: "repo-review",
					defaultModel: "anthropic/claude-haiku-4-5",
					state: "active",
					members: [],
				}),
				getTeam: () => undefined,
			},
			createTaskStore: () => ({ listTasks: () => [] }) as unknown,
		});

		await commands.get("team")!.handler("", createCommandContext());
		setCoordinatorMode?.(false);

		assert.equal(sent.length, 1);
		const message = sent[0] as { content: string };
		assert.match(message.content, /\*\*Roster\*\*/);
		assert.match(message.content, /No teammates/);
	});

	it("registers a single team inspection surface without /workers", () => {
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const pi = {
			events: createEventBus(),
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage() {},
		};
		setCoordinatorMode?.(true);
		registerSlashCommands!(pi, createState(process.cwd()), {});
		setCoordinatorMode?.(false);

		assert.equal(commands.has("team"), true);
		assert.equal(commands.has("workers"), false);
		assert.equal(commands.has("stop-all"), true);
	});
});
