import assert from "node:assert/strict";
import { describe, it } from "node:test";

const SLASH_RESULT_TYPE = "subagent-slash-result";
const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";

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
	) => void;
}

let registerSlashCommands: RegisterSlashCommandsModule["registerSlashCommands"];
let available = true;
try {
	({ registerSlashCommands } = await import("./slash-commands.ts") as RegisterSlashCommandsModule);
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
	it("/run sends an inline slash result message after a successful bridge response", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
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
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Subagent failed" }],
					details: { mode: "single", results: [] },
				},
				isError: true,
				errorText: "Subagent failed",
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
		assert.equal(final.content, "Subagent failed");
		assert.equal(final.display, false);
	});
});
