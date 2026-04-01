/**
 * Team Tool
 *
 * Full-featured worker delegation with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Modes: single (agent + task), parallel (tasks[]), chain (chain[] with {previous})
 * Toggle: async parameter (default: false, configurable via config.json)
 *
 * Config file: ~/.pi/agent/extensions/pi-teams/config.json
 *   { "asyncByDefault": true }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@mariozechner/pi-tui";
import { discoverAgents } from "./agents.js";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "./artifacts.js";
import { cleanupOldChainDirs } from "./settings.js";
import { renderWidget, renderTeamResult } from "./render.js";
import { TeamParams, StatusParams } from "./schemas.js";
import { findByPrefix, readStatus } from "./utils.js";
import { createTeamExecutor } from "./team-executor.js";
import { createAsyncJobTracker } from "./async-job-tracker.js";
import { createResultWatcher } from "./result-watcher.js";
import { registerSlashCommands } from "./slash-commands.js";
import { registerPromptTemplateDelegationBridge } from "./prompt-template-bridge.js";
import { registerSlashTeamBridge } from "./slash-bridge.js";
import { clearSlashSnapshots, getSlashRenderableSnapshot, resolveSlashMessageDetails, restoreSlashFinalSnapshots, type SlashMessageDetails } from "./slash-live-state.js";
import {
	type Details,
	type ExtensionConfig,
	type TeamState,
	ASYNC_DIR,
	DEFAULT_ARTIFACT_CONFIG,
	RESULTS_DIR,
	SLASH_RESULT_TYPE,
	WIDGET_KEY,
} from "./types.js";
import { AgentRegistry } from "./agent-registry.js";
import {
	getCoordinatorSettings,
	getCurrentTeammateTeamName,
	getRuntimeRole,
	getTeammateSystemPromptBlock,
	isLeadRuntimeRole,
	setCoordinatorMode,
} from "./coordinator.js";
import { getCoordinatorSystemPrompt } from "./coordinator-prompt.js";
import { createTaskStopTool } from "./task-stop-tool.js";
import { createSendMessageTool } from "./send-message-tool.js";
import { createResumeAgent } from "./teammate-continuation.js";
import { createLifecycleDedupe } from "./lifecycle-dedupe.js";
import { TeamManager } from "./team-manager.js";
import { TaskStore } from "./task-store.js";
import {
	createCheckTeammateTool,
	createSpawnTeammateTool,
	createTeamCreateTool,
	createTeamShutdownTool,
} from "./team-tools.js";
import {
	createTaskCreateTool,
	createTaskListTool,
	createTaskReadTool,
	createTaskUpdateTool,
} from "./task-tools.js";

/**
 * Derive worker session base directory from parent session file.
 * If parent session is ~/.pi/agent/sessions/abc123.jsonl,
 * returns ~/.pi/agent/sessions/abc123/ as the base.
 * Callers add runId to create the actual session root: abc123/{runId}/
 * Falls back to a unique temp directory if no parent session.
 */
function getTeamSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-session-"));
}

function loadConfig(): ExtensionConfig {
	const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-teams", "config.json");
	try {
		if (fs.existsSync(configPath)) {
			return JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExtensionConfig;
		}
	} catch (error) {
		console.error(`Failed to load pi-teams config from '${configPath}':`, error);
	}
	return {};
}

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Create a directory and verify it is actually accessible.
 * On Windows with Azure AD/Entra ID, directories created shortly after
 * wake-from-sleep can end up with broken NTFS ACLs (null DACL) when the
 * cloud SID cannot be resolved without network connectivity. This leaves
 * the directory completely inaccessible to the creating user.
 */
function ensureAccessibleDir(dirPath: string): void {
	fs.mkdirSync(dirPath, { recursive: true });
	try {
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	} catch {
		try {
			fs.rmSync(dirPath, { recursive: true, force: true });
		} catch {
			// Best effort: retry mkdir/access even if cleanup fails.
		}
		fs.mkdirSync(dirPath, { recursive: true });
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	}
}

function isSlashResultRunning(result: { details?: Details }): boolean {
	return result.details?.progress?.some((entry) => entry.status === "running")
		|| result.details?.results.some((entry) => entry.progress?.status === "running")
		|| false;
}

function isSlashResultError(result: { details?: Details }): boolean {
	return result.details?.results.some((entry) => entry.exitCode !== 0 && entry.progress?.status !== "running") || false;
}

function rebuildSlashResultContainer(
	container: Container,
	result: AgentToolResult<Details>,
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
): void {
	container.clear();
	container.addChild(new Spacer(1));
	const boxTheme = isSlashResultRunning(result) ? "toolPendingBg" : isSlashResultError(result) ? "toolErrorBg" : "toolSuccessBg";
	const box = new Box(1, 1, (text: string) => theme.bg(boxTheme, text));
	box.addChild(renderTeamResult(result, options, theme));
	container.addChild(box);
}

function createSlashResultComponent(
	details: SlashMessageDetails,
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
): Container {
	const container = new Container();
	let lastVersion = -1;
	container.render = (width: number): string[] => {
		const snapshot = getSlashRenderableSnapshot(details);
		if (snapshot.version !== lastVersion) {
			lastVersion = snapshot.version;
			rebuildSlashResultContainer(container, snapshot.result, options, theme);
		}
		return Container.prototype.render.call(container, width);
	};
	return container;
}

export default function registerTeamExtension(pi: ExtensionAPI): void {
	ensureAccessibleDir(RESULTS_DIR);
	ensureAccessibleDir(ASYNC_DIR);
	cleanupOldChainDirs();

	const runtimeRole = getRuntimeRole();
	const isLeadRuntime = isLeadRuntimeRole();

	pi.on("before_agent_start", (event) => {
		if (runtimeRole === "lead") {
			return {
				systemPrompt: getCoordinatorSystemPrompt(event.systemPrompt),
			};
		}
		if (runtimeRole === "teammate") {
			const teammateBlock = getTeammateSystemPromptBlock();
			if (teammateBlock) {
				return {
					systemPrompt: event.systemPrompt
						? `${event.systemPrompt}\n\n${teammateBlock}`
						: teammateBlock,
				};
			}
		}
		return undefined;
	});

	const config = loadConfig();
	const asyncByDefault = config.asyncByDefault === true;
	const tempArtifactsDir = getArtifactsDir(null);
	cleanupAllArtifactDirs(DEFAULT_ARTIFACT_CONFIG.cleanupDays);

	const state: TeamState = {
		baseCwd: process.cwd(),
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

	const { startResultWatcher, primeExistingResults, stopResultWatcher } = createResultWatcher(
		pi,
		state,
		RESULTS_DIR,
		10 * 60 * 1000,
	);
	startResultWatcher();
	primeExistingResults();

	const registry = new AgentRegistry();
	const lifecycleDedupe = createLifecycleDedupe();
	const emitTeamCompletion = (payload: {
		id: string;
		agent: string;
		name?: string;
		status: "completed" | "failed" | "stopped" | "timed_out";
		summary: string;
		exitCode?: number;
		usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
	}) => {
		pi.events.emit("team:complete", {
			id: payload.id,
			agent: payload.agent,
			name: payload.name,
			status: payload.status,
			success: payload.status === "completed",
			summary: payload.summary,
			exitCode: payload.exitCode ?? (payload.status === "completed" ? 0 : 1),
			timestamp: Date.now(),
			usage: payload.usage,
		});
	};
	const teamManager = new TeamManager({
		registry,
		getCurrentSessionId: () => state.currentSessionId,
		getCurrentTeammateTeamName,
		onMemberStopped: (member, team, reason) => {
			emitTeamCompletion({
				id: member.agentId,
				agent: member.agentType,
				name: member.name,
				status: "stopped",
				summary: reason ?? `Team "${team.name}" stopped by lead session`,
			});
		},
	});
	const createTaskStore = (teamName: string) => new TaskStore(teamName, teamManager.getTasksPath(teamName));

	const { ensurePoller, handleStarted, handleComplete, resetJobs } = createAsyncJobTracker(state, ASYNC_DIR);
	const executor = createTeamExecutor({
		pi,
		state,
		config,
		asyncByDefault,
		tempArtifactsDir,
		getTeamSessionRoot,
		expandTilde,
		discoverAgents,
		registry,
	});

	pi.registerMessageRenderer<SlashMessageDetails>(SLASH_RESULT_TYPE, (message, options, theme) => {
		const details = resolveSlashMessageDetails(message.details);
		if (!details) return undefined;
		return createSlashResultComponent(details, options, theme);
	});

	const slashBridge = registerSlashTeamBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: (id, params, signal, onUpdate, ctx) =>
			executor.execute(id, params, signal, onUpdate, ctx),
	});

	const promptTemplateBridge = registerPromptTemplateDelegationBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: async (requestId, request, signal, ctx, onUpdate) => {
			if (request.tasks && request.tasks.length > 0) {
				return executor.execute(
					requestId,
					{
						tasks: request.tasks,
						context: request.context,
						cwd: request.cwd,
						async: false,
						clarify: false,
					},
					signal,
					onUpdate,
					ctx,
				);
			}
			return executor.execute(
				requestId,
				{
					agent: request.agent,
					task: request.task,
					context: request.context,
					cwd: request.cwd,
					model: request.model,
					async: false,
					clarify: false,
				},
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	const tool: ToolDefinition<typeof TeamParams, Details> = {
		name: "team",
		label: "Team",
		description: `Delegate to workers or manage agent definitions.

EXECUTION (use exactly ONE mode):
• SINGLE: { agent, task } - one task
• CHAIN: { chain: [{agent:"scout"}, {agent:"planner"}] } - sequential pipeline
• PARALLEL: { tasks: [{agent,task}, ...] } - concurrent execution
• Optional context: { context: "fresh" | "fork" } (default: "fresh")

CHAIN TEMPLATE VARIABLES (use in task strings):
• {task} - The original task/request from the user
• {previous} - Text response from the previous step (empty for first step)
• {chain_dir} - Shared directory for chain files (e.g., <tmpdir>/pi-chain-runs/abc123/)

Example: { chain: [{agent:"scout", task:"Analyze {task}"}, {agent:"planner", task:"Plan based on {previous}"}] }

MANAGEMENT (use action field, omit agent/task/chain/tasks):
• { action: "list" } - discover agents/chains
• { action: "get", agent: "name" } - full agent detail
• { action: "create", config: { name, systemPrompt, ... } }
• { action: "update", agent: "name", config: { ... } } - merge
• { action: "delete", agent: "name" }
• Use chainName for chain operations`,
		parameters: TeamParams,

		execute(id, params, signal, onUpdate, ctx) {
			return executor.execute(id, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			if (args.action) {
				const target = args.agent || args.chainName || "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("team "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
					0, 0,
				);
			}
			const isParallel = (args.tasks?.length ?? 0) > 0;
			const asyncLabel = args.async === true && !isParallel ? theme.fg("warning", " [async]") : "";
			if (args.chain?.length)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("team "))}chain (${args.chain.length})${asyncLabel}`,
					0,
					0,
				);
			if (isParallel)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("team "))}parallel (${args.tasks!.length})`,
					0,
					0,
				);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("team "))}${theme.fg("accent", args.agent || "?")}${asyncLabel}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			return renderTeamResult(result, options, theme);
		},

	};

	const statusTool: ToolDefinition<typeof StatusParams, Details> = {
		name: "team_status",
		label: "Team Status",
		description: "Inspect async worker run status and artifacts",
		parameters: StatusParams,

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			let asyncDir: string | null = null;
			let resolvedId = params.id;

			if (params.dir) {
				asyncDir = path.resolve(params.dir);
			} else if (params.id) {
				const direct = path.join(ASYNC_DIR, params.id);
				if (fs.existsSync(direct)) {
					asyncDir = direct;
				} else {
					const match = findByPrefix(ASYNC_DIR, params.id);
					if (match) {
						asyncDir = match;
						resolvedId = path.basename(match);
					}
				}
			}

			const resultPath =
				params.id && !asyncDir ? findByPrefix(RESULTS_DIR, params.id, ".json") : null;

			if (!asyncDir && !resultPath) {
				return {
					content: [{ type: "text", text: "Async run not found. Provide id or dir." }],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}

			if (asyncDir) {
				const status = readStatus(asyncDir);
				const logPath = path.join(asyncDir, `team-log-${resolvedId ?? "unknown"}.md`);
				const eventsPath = path.join(asyncDir, "events.jsonl");
				if (status) {
					const stepsTotal = status.steps?.length ?? 1;
					const current = status.currentStep !== undefined ? status.currentStep + 1 : undefined;
					const stepLine =
						current !== undefined ? `Step: ${current}/${stepsTotal}` : `Steps: ${stepsTotal}`;
					const started = new Date(status.startedAt).toISOString();
					const updated = status.lastUpdate ? new Date(status.lastUpdate).toISOString() : "n/a";

					const lines = [
						`Run: ${status.runId}`,
						`State: ${status.state}`,
						`Mode: ${status.mode}`,
						stepLine,
						`Started: ${started}`,
						`Updated: ${updated}`,
						`Dir: ${asyncDir}`,
					];
					if (status.sessionFile) lines.push(`Session: ${status.sessionFile}`);
					if (fs.existsSync(logPath)) lines.push(`Log: ${logPath}`);
					if (fs.existsSync(eventsPath)) lines.push(`Events: ${eventsPath}`);

					return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
				}
			}

			if (resultPath) {
				try {
					const raw = fs.readFileSync(resultPath, "utf-8");
					const data = JSON.parse(raw) as { id?: string; success?: boolean; summary?: string };
					const status = data.success ? "complete" : "failed";
					const lines = [`Run: ${data.id ?? params.id}`, `State: ${status}`, `Result: ${resultPath}`];
					if (data.summary) lines.push("", data.summary);
					return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: `Failed to read async result file: ${message}` }],
						isError: true,
						details: { mode: "single" as const, results: [] },
					};
				}
			}

			return {
				content: [{ type: "text", text: "Status file not found." }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		},
	};

	pi.registerTool(tool);
	pi.registerTool(statusTool);

	pi.registerTool(createCheckTeammateTool(teamManager));
	pi.registerTool(createTaskListTool({ teamManager, createTaskStore }));
	pi.registerTool(createTaskReadTool({ teamManager, createTaskStore }));

	if (isLeadRuntime) {
		pi.registerTool(createSendMessageTool(registry, {
			resumeAgent: createResumeAgent({
				execute: executor.execute,
				teamManager,
				getFallbackCwd: () => state.baseCwd,
			}),
		}));
		pi.registerTool(createTaskStopTool(registry, (agent) => {
			emitTeamCompletion({
				id: agent.id,
				agent: agent.agent,
				name: agent.name,
				status: "stopped",
				summary: agent.summary,
			});
		}));
		pi.registerTool(createTeamCreateTool(teamManager));
		pi.registerTool(createSpawnTeammateTool({
			teamManager,
			listAssignedTasks: (teamName, teammateName) => createTaskStore(teamName)
				.listTasks()
				.filter((task) => task.owner?.toLowerCase() === teammateName.toLowerCase()),
			spawnTeammate: async (request, ctx, signal) => {
				const callId = `teammate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				const result = await executor.execute(callId, {
					agent: "worker",
					task: request.prompt,
					name: request.name,
					cwd: request.cwd,
					model: request.effectiveModel,
					clarify: false,
					async: false,
					runtimeRole: "teammate",
					teamMetadata: {
						teamName: request.teamName,
						teammateNames: request.teammateNames,
						assignedTaskIds: request.assignedTaskIds,
						configPath: request.configPath,
						tasksPath: request.tasksPath,
					},
				}, signal, undefined, ctx);
				if (result.isError || !result.details?.asyncId) {
					throw new Error(result.content.map((item) => item.type === "text" ? item.text : "").join("\n") || "Failed to spawn teammate");
				}
				return {
					agentId: result.details.asyncId,
					effectiveModel: request.effectiveModel,
				};
			},
		}));
		pi.registerTool(createTeamShutdownTool(teamManager));
		pi.registerTool(createTaskCreateTool({ teamManager, createTaskStore }));
		pi.registerTool(createTaskUpdateTool({ teamManager, createTaskStore }));
		registerSlashCommands(pi, state, {
			registry,
			teamManager,
			createTaskStore,
		});
	}

	const handleAgentStartedEvent = (data: unknown) => {
		const d = data as { id?: string; agent?: string; name?: string; task?: string; _coordinatorManaged?: boolean };
		if (!d.id || !lifecycleDedupe.shouldProcess(`started:${d.id}`)) return;
		handleStarted(data);
		if (!d._coordinatorManaged && !registry.resolve(d.id)) {
			try {
				registry.register({
					id: d.id,
					name: d.name,
					agentType: d.agent ?? "unknown",
					task: d.task ?? "",
					status: "running",
					startTime: Date.now(),
				});
			} catch {
				// Name collision or duplicate ID
			}
		}
	};
	const handleAgentCompleteEvent = (data: unknown) => {
		const d = data as { id?: string; success?: boolean; summary?: string; status?: "completed" | "failed" | "stopped" | "timed_out" };
		if (!d.id) return;
		const status = d.status ?? (d.success === false ? "failed" : "completed");
		if (!lifecycleDedupe.shouldProcess(`complete:${d.id}:${status}`)) return;
		handleComplete({ ...d, success: status === "completed" });
		registry.updateStatus(d.id, status, d.summary);
		teamManager.recordTeammateStatus(d.id, status, d.summary);
	};
	pi.events.on("team:started", handleAgentStartedEvent);
	pi.events.on("team:complete", handleAgentCompleteEvent);

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "team") return;
		if (!ctx.hasUI) return;
		state.lastUiContext = ctx;
		if (state.asyncJobs.size > 0) {
			renderWidget(ctx, Array.from(state.asyncJobs.values()));
			ensurePoller();
		}
	});

	const cleanupSessionArtifacts = (ctx: ExtensionContext) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile) {
				cleanupOldArtifacts(getArtifactsDir(sessionFile), DEFAULT_ARTIFACT_CONFIG.cleanupDays);
			}
		} catch {
			// Cleanup failures should not block session lifecycle events.
		}
	};

	const resetSessionState = (ctx: ExtensionContext) => {
		state.baseCwd = ctx.cwd;
		state.currentSessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		state.lastUiContext = ctx;
		cleanupSessionArtifacts(ctx);
		resetJobs(ctx);
		restoreSlashFinalSnapshots(ctx.sessionManager.getEntries());
	};

	pi.on("session_start", (_event, ctx) => {
		resetSessionState(ctx);
		setCoordinatorMode(isLeadRuntime);
		if (isLeadRuntime) {
			teamManager.bootstrap();
			registry.startTimeoutSweeper(getCoordinatorSettings().workerTimeoutMs, 30_000, (agent) => {
				emitTeamCompletion({
					id: agent.id,
					agent: agent.agentType,
					name: agent.name,
					status: "timed_out",
					summary: `Timed out after ${getCoordinatorSettings().workerTimeoutMs}ms`,
				});
			});
		}
	});
	pi.on("session_switch", (_event, ctx) => {
		if (isLeadRuntime) {
			teamManager.shutdownActiveTeam("Lead session switched");
		}
		registry.dispose();
		resetSessionState(ctx);
		if (isLeadRuntime) {
			teamManager.bootstrap();
		}
	});
	pi.on("session_branch", (_event, ctx) => {
		if (isLeadRuntime) {
			teamManager.shutdownActiveTeam("Lead session branched");
		}
		registry.dispose();
		resetSessionState(ctx);
		if (isLeadRuntime) {
			teamManager.bootstrap();
		}
	});
	pi.on("session_shutdown", () => {
		if (isLeadRuntime) {
			teamManager.shutdownActiveTeam("Lead session shutdown");
		}
		registry.dispose();
		stopResultWatcher();
		if (state.poller) clearInterval(state.poller);
		state.poller = null;
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		clearSlashSnapshots();
		slashBridge.cancelAll();
		slashBridge.dispose();
		promptTemplateBridge.cancelAll();
		promptTemplateBridge.dispose();
		if (state.lastUiContext?.hasUI) {
			state.lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
		}
	});
}
