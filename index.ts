/**
 * Team Tool
 *
 * Team-first orchestration with a single team lifecycle surface.
 *
 * Modes: single (agent + task), parallel (tasks[]), chain (chain[] with {previous})
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
import { renderTeamResult } from "./render.js";
import { applySnapshotIfChanged, createTeammateWidgetController } from "./teammate-widget-controller.js";
import {
	buildLiveWidgetRenderState,
	clearTeammateWidgets,
	LEGACY_ASYNC_WIDGET_KEY,
	TEAMMATE_WIDGET_KEY,
} from "./teammate-live-widget.js";
import { TeamParams } from "./schemas.js";
import { startLeadSessionRuntime } from "./lead-session-runtime.js";
import { createTeamExecutor } from "./team-executor.js";
import { createResultWatcher } from "./result-watcher.js";
import { registerSlashCommands } from "./slash-commands.js";
import { registerPromptTemplateDelegationBridge } from "./prompt-template-bridge.js";
import { registerSlashTeamBridge } from "./slash-bridge.js";
import { clearSlashSnapshots, getSlashRenderableSnapshot, resolveSlashMessageDetails, restoreSlashFinalSnapshots, type SlashMessageDetails } from "./slash-live-state.js";
import {
	type Details,
	type ExtensionConfig,
	type TeamState,
	DEFAULT_ARTIFACT_CONFIG,
	RESULTS_DIR,
	SLASH_RESULT_TYPE,
} from "./types.js";
import { AgentRegistry } from "./agent-registry.js";
import { clearLeaderTeamName } from "./leader-team-state.js";
import {
	getCoordinatorSettings,
	getCurrentTeammateName,
	getCurrentTeammateTeamName,
	getRuntimeRole,
	getTeammateSystemPromptBlock,
	isLeadRuntimeRole,
	setCoordinatorMode,
} from "./coordinator.js";
import { getCoordinatorSystemPrompt } from "./coordinator-prompt.js";
import { createTaskStopTool } from "./task-stop-tool.js";
import { createSendMessageTool } from "./send-message-tool.js";
import { markMailboxMessagesRead, readUnreadMailboxMessages } from "./teammate-mailbox.js";
import { createResumeAgent } from "./teammate-continuation.js";
import { createLifecycleDedupe } from "./lifecycle-dedupe.js";
import { TeamManager } from "./team-manager.js";
import { TaskStore } from "./task-store.js";
import {
	createCheckTeammateTool,
	createSpawnTeammateTool,
	createTeamCreateTool,
	createTeamDeleteTool,
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

const TEAMMATE_WIDGET_PROGRESS_THROTTLE_MS = 1000;

export default function registerTeamExtension(pi: ExtensionAPI): void {
	ensureAccessibleDir(RESULTS_DIR);
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
	const orphanCleanupMaxAgeHours = Number.isFinite(config.orphanCleanupMaxAgeHours)
		? Math.max(1, Number(config.orphanCleanupMaxAgeHours))
		: 72;
	const orphanCleanupMaxAgeMs = orphanCleanupMaxAgeHours * 60 * 60 * 1000;
	cleanupAllArtifactDirs(DEFAULT_ARTIFACT_CONFIG.cleanupDays);

	const state: TeamState = {
		baseCwd: process.cwd(),
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
	const appendUnassignedTaskSummary = (
		summary: string,
		unassigned: { unassignedTasks: Array<{ id: string; subject: string }> },
	): string => {
		if (unassigned.unassignedTasks.length === 0) return summary;
		const listedTasks = unassigned.unassignedTasks.map((task) => `${task.id} "${task.subject}"`).join(", ");
		return `${summary}\nUnassigned ${unassigned.unassignedTasks.length} open task(s): ${listedTasks}`;
	};
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
		getCurrentTeammateName,
		onMemberStopped: (member, team, reason, unassigned) => {
			emitTeamCompletion({
				id: member.agentId,
				agent: member.agentType,
				name: member.name,
				status: "stopped",
				summary: appendUnassignedTaskSummary(reason ?? `Team "${team.name}" stopped by lead session`, unassigned),
			});
		},
	});
	const createTaskStore = (teamName: string) => new TaskStore(teamName, teamManager.getTasksPath(teamName));
	const teammateWidgetSnapshot = { current: null as string | null };
	const orphanCleanupWarned = new Set<string>();
	const TEAMMATE_WIDGET_ANIMATION_INTERVAL_MS = 900;
	let teammateWidgetFrame = 0;
	let teammateWidgetAnimationTimer: ReturnType<typeof setInterval> | null = null;

	const stopTeammateWidgetAnimation = () => {
		if (!teammateWidgetAnimationTimer) return;
		clearInterval(teammateWidgetAnimationTimer);
		teammateWidgetAnimationTimer = null;
	};

	const renderTeammateWidget = () => {
		if (!isLeadRuntime) return;
		const ctx = state.lastUiContext;
		if (!ctx?.hasUI) return;
		const result = buildLiveWidgetRenderState({
			team: teamManager.getActiveTeam(),
			checkTeammate: (teamName, memberName) => teamManager.checkTeammate(teamName, memberName),
			resolveAgent: (agentIdOrName) => registry.resolve(agentIdOrName),
			nowMs: Date.now(),
			frame: teammateWidgetFrame,
		});
		teammateWidgetFrame = result.nextFrame;
		syncTeammateWidgetAnimation(result.shouldAnimate);
		applySnapshotIfChanged(result.snapshot, teammateWidgetSnapshot, () => {
			ctx.ui.setWidget(TEAMMATE_WIDGET_KEY, result.lines && result.lines.length > 0 ? result.lines : undefined);
			ctx.ui.setWidget(LEGACY_ASYNC_WIDGET_KEY, undefined);
		});
	};

	const teammateWidgetController = createTeammateWidgetController({
		progressThrottleMs: TEAMMATE_WIDGET_PROGRESS_THROTTLE_MS,
		render: renderTeammateWidget,
	});

	const scheduleTeammateWidgetRender = (kind: "state" | "progress" = "state") => {
		if (!isLeadRuntime) return;
		teammateWidgetController.schedule(kind);
	};

	const syncTeammateWidgetAnimation = (shouldAnimate: boolean) => {
		if (!isLeadRuntime) {
			stopTeammateWidgetAnimation();
			return;
		}
		if (!shouldAnimate) {
			stopTeammateWidgetAnimation();
			return;
		}
		if (teammateWidgetAnimationTimer) return;
		teammateWidgetAnimationTimer = setInterval(() => {
			scheduleTeammateWidgetRender("progress");
		}, TEAMMATE_WIDGET_ANIMATION_INTERVAL_MS);
		teammateWidgetAnimationTimer.unref?.();
	};

	const clearTeammateWidget = () => {
		teammateWidgetController.clear();
		stopTeammateWidgetAnimation();
		applySnapshotIfChanged(null, teammateWidgetSnapshot, () => {
			if (state.lastUiContext?.hasUI) {
				clearTeammateWidgets(state.lastUiContext.ui);
			}
		});
	};

	const notifyTeam = (content: string) => {
		pi.sendMessage(
			{ customType: "team-notify", content, display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

	const TEAM_INBOX_POLL_INTERVAL_MS = 1000;
	let teamInboxPoller: ReturnType<typeof setInterval> | null = null;

	const stopTeamInboxPoller = () => {
		if (!teamInboxPoller) return;
		clearInterval(teamInboxPoller);
		teamInboxPoller = null;
	};

	const processLeadMailbox = (teamName: string) => {
		const teamDir = teamManager.getTeamDir(teamName);
		const unread = readUnreadMailboxMessages(teamDir, "lead");
		if (unread.length === 0) return;
		const team = teamManager.getTeam(teamName);
		const acknowledged: string[] = [];
		for (const message of unread) {
			if (message.payload.type === "shutdown_response") {
				const sender = message.from.trim().toLowerCase();
				const member = team?.members.find((entry) => entry.name.toLowerCase() === sender);
				if (!member) {
					notifyTeam(`Ignored shutdown response from unknown teammate "${message.from}".`);
					acknowledged.push(message.id);
					continue;
				}
				try {
					const outcome = teamManager.handleShutdownResponseForAgent(member.agentId, {
						requestId: message.payload.requestId,
						approve: message.payload.approve,
						reason: message.payload.reason,
					});
					if (outcome.approved) {
						registry.stopAgent(member.agentId);
						emitTeamCompletion({
							id: member.agentId,
							agent: member.agentType,
							name: member.name,
							status: "stopped",
							summary: appendUnassignedTaskSummary(outcome.summary, outcome.unassigned),
						});
					} else {
						notifyTeam(`Graceful shutdown rejected by "${outcome.member.name}": ${outcome.reason}`);
					}
				} catch (error) {
					notifyTeam(`Invalid shutdown response from "${message.from}": ${error instanceof Error ? error.message : String(error)}`);
				}
				acknowledged.push(message.id);
				continue;
			}

			const summary = message.payload.summary?.trim() || message.payload.text.trim().split("\n")[0] || "(empty message)";
			notifyTeam(`Inbox message from "${message.from}": ${summary}`);
			acknowledged.push(message.id);
		}
		if (acknowledged.length > 0) {
			markMailboxMessagesRead(teamDir, "lead", acknowledged);
		}
	};

	const processTeammateMailbox = (teamName: string, teammateName: string, agentId: string) => {
		const teamDir = teamManager.getTeamDir(teamName);
		const unread = readUnreadMailboxMessages(teamDir, teammateName);
		if (unread.length === 0) return;
		const live = registry.resolve(agentId) ?? registry.resolve(teammateName);
		if (!live?.rpcHandle || live.status !== "running") {
			return;
		}
		const deliveredIds: string[] = [];
		for (const message of unread) {
			if (message.payload.type !== "plain_text") {
				deliveredIds.push(message.id);
				continue;
			}
			try {
				live.rpcHandle.stdin.write(JSON.stringify({ type: "follow_up", message: message.payload.text }) + "\n");
				registry.patch(live.id, { lastUpdateAt: Date.now(), result: message.payload.summary ?? message.payload.text });
				teamManager.recordTeammateActivity(live.id, true, message.payload.summary ?? message.payload.text);
				deliveredIds.push(message.id);
			} catch {
				break;
			}
		}
		if (deliveredIds.length > 0) {
			markMailboxMessagesRead(teamDir, teammateName, deliveredIds);
		}
	};

	const pollTeamMailboxes = () => {
		if (!isLeadRuntime) return;
		const team = teamManager.getActiveTeam();
		if (!team) return;
		processLeadMailbox(team.name);
		for (const member of team.members) {
			if (member.status !== "running") continue;
			processTeammateMailbox(team.name, member.name, member.agentId);
		}
	};

	const startTeamInboxPoller = () => {
		if (!isLeadRuntime) return;
		if (teamInboxPoller) return;
		teamInboxPoller = setInterval(() => {
			pollTeamMailboxes();
		}, TEAM_INBOX_POLL_INTERVAL_MS);
		teamInboxPoller.unref?.();
	};

	const executor = createTeamExecutor({
		pi,
		state,
		config,
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
		description: `Delegate raw agent work or manage agent definitions.

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
			if (args.chain?.length)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("team "))}chain (${args.chain.length})`,
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
				`${theme.fg("toolTitle", theme.bold("team "))}${theme.fg("accent", args.agent || "?")}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			return renderTeamResult(result, options, theme);
		},

	};

	pi.registerTool(tool);

	pi.registerTool(createCheckTeammateTool(teamManager));
	pi.registerTool(createTaskListTool({ teamManager, createTaskStore }));
	pi.registerTool(createTaskReadTool({ teamManager, createTaskStore }));
	pi.registerTool(createTaskUpdateTool({ teamManager, createTaskStore }));

	if (isLeadRuntime || runtimeRole === "teammate") {
		pi.registerTool(createSendMessageTool(registry, {
			resumeAgent: isLeadRuntime
				? createResumeAgent({
					execute: executor.execute,
					teamManager,
					getFallbackCwd: () => state.baseCwd,
				})
				: undefined,
			teamManager,
			runtimeRole,
		}));
	}

	if (isLeadRuntime) {
		pi.registerTool(createTaskStopTool(registry, (agent) => {
			const unassigned = teamManager.unassignOpenTasksForAgent(agent.id);
			emitTeamCompletion({
				id: agent.id,
				agent: agent.agent,
				name: agent.name,
				status: "stopped",
				summary: appendUnassignedTaskSummary(agent.summary, unassigned),
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
					runtimeRole: "teammate",
					teamMetadata: {
						teamName: request.teamName,
						teammateName: request.name,
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
		pi.registerTool(createTeamDeleteTool(teamManager));
		pi.registerTool(createTaskCreateTool({ teamManager, createTaskStore }));
		registerSlashCommands(pi, state, {
			registry,
			teamManager,
			createTaskStore,
		});
	}

	const handleAgentStartedEvent = (data: unknown) => {
		const d = data as { id?: string; agent?: string; name?: string; task?: string; _coordinatorManaged?: boolean };
		if (!d.id || !lifecycleDedupe.shouldProcess(`started:${d.id}`)) return;
		if (!d._coordinatorManaged) {
			if (!registry.resolve(d.id)) {
				try {
					registry.register({
						id: d.id,
						name: d.name,
						agentType: d.agent ?? "unknown",
						task: d.task ?? "",
						status: "running",
						startTime: Date.now(),
						lastUpdateAt: Date.now(),
					});
				} catch {
					// Name collision or duplicate ID
				}
			}
		}
		scheduleTeammateWidgetRender("state");
	};
	const handleAgentCompleteEvent = (data: unknown) => {
		const d = data as { id?: string; success?: boolean; summary?: string; status?: "completed" | "failed" | "stopped" | "timed_out" };
		if (!d.id) return;
		const reportedStatus = d.status ?? (d.success === false ? "failed" : "completed");
		const resolved = teamManager.resolveTeammateCompletion(d.id, reportedStatus, d.summary);
		const status = resolved.status;
		const summary = resolved.summary;
		if (!lifecycleDedupe.shouldProcess(`complete:${d.id}:${status}`)) return;
		registry.updateStatus(d.id, status, summary);
		registry.patch(d.id, { lastUpdateAt: Date.now() });
		teamManager.recordTeammateStatus(d.id, status, summary);
		scheduleTeammateWidgetRender("state");
	};
	const handleTeammateIdleEvent = (data: unknown) => {
		const d = data as { agentId?: string; summary?: string };
		if (!d.agentId) return;
		teamManager.recordTeammateActivity(d.agentId, false, d.summary);
		registry.patch(d.agentId, {
			result: d.summary,
			lastUpdateAt: Date.now(),
		});
		scheduleTeammateWidgetRender("state");
	};
	const handleTeammateProgressEvent = (data: unknown) => {
		const d = data as {
			agentId?: string;
			summary?: string;
			currentTool?: string;
			recentOutput?: string[];
			task?: string;
			toolCount?: number;
			tokens?: number;
		};
		if (!d.agentId) return;
		const summary = d.summary?.trim();
		const fallbackSummary = summary && summary.length > 0 ? summary : d.task;
		const patch: {
			currentTool?: string;
			recentOutput?: string[];
			result?: string;
			lastUpdateAt: number;
			toolCount?: number;
			tokens?: number;
		} = {
			currentTool: d.currentTool,
			recentOutput: d.recentOutput?.slice(-5),
			result: fallbackSummary,
			lastUpdateAt: Date.now(),
		};
		if (typeof d.toolCount === "number") patch.toolCount = d.toolCount;
		if (typeof d.tokens === "number") patch.tokens = d.tokens;
		teamManager.recordTeammateActivity(d.agentId, true, fallbackSummary);
		registry.patch(d.agentId, patch);
		scheduleTeammateWidgetRender("progress");
	};
	pi.events.on("team:started", handleAgentStartedEvent);
	pi.events.on("team:complete", handleAgentCompleteEvent);
	pi.events.on("team:teammate-idle", handleTeammateIdleEvent);
	pi.events.on("team:teammate-progress", handleTeammateProgressEvent);

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "team") return;
		if (!ctx.hasUI) return;
		state.lastUiContext = ctx;
		if (isLeadRuntime) {
			scheduleTeammateWidgetRender("state");
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
		restoreSlashFinalSnapshots(ctx.sessionManager.getEntries());
		if (ctx.hasUI) {
			clearTeammateWidgets(ctx.ui);
		}
		if (isLeadRuntime) {
			clearTeammateWidget();
		}
	};

	const runStartupOrphanCleanup = () => {
		if (!isLeadRuntime) return;
		const result = teamManager.cleanupOrphanedTeams(orphanCleanupMaxAgeMs);
		for (const failure of result.failures) {
			if (failure.message.startsWith("Corrupt team config:")) continue;
			const warningKey = `${failure.teamName}:${failure.message}`;
			if (orphanCleanupWarned.has(warningKey)) continue;
			orphanCleanupWarned.add(warningKey);
			console.warn(`[pi-teams] orphan cleanup issue for ${failure.teamName}: ${failure.message}`);
		}
	};

	const startLeadSessionServices = () => {
		const timeoutMs = getCoordinatorSettings().workerTimeoutMs;
		startLeadSessionRuntime({
			bootstrapTeamManager: () => teamManager.bootstrap(),
			runStartupOrphanCleanup,
			startTeamInboxPoller,
			scheduleTeammateWidgetRender,
			startTimeoutSweeper: () => registry.startTimeoutSweeper(timeoutMs, 30_000, (agent) => {
				const unassigned = teamManager.unassignOpenTasksForAgent(agent.id);
				emitTeamCompletion({
					id: agent.id,
					agent: agent.agentType,
					name: agent.name,
					status: "timed_out",
					summary: appendUnassignedTaskSummary(`Timed out after ${timeoutMs}ms`, unassigned),
				});
			}),
		});
	};

	pi.on("session_start", (_event, ctx) => {
		resetSessionState(ctx);
		setCoordinatorMode(isLeadRuntime);
		if (isLeadRuntime) {
			startLeadSessionServices();
		}
	});
	pi.on("session_switch", (_event, ctx) => {
		const previousSessionId = state.currentSessionId;
		if (isLeadRuntime) {
			teamManager.cleanupSessionTeams("Lead session switched");
			clearLeaderTeamName(previousSessionId);
			clearTeammateWidget();
			stopTeamInboxPoller();
		}
		registry.dispose();
		resetSessionState(ctx);
		if (isLeadRuntime) {
			startLeadSessionServices();
		}
	});
	pi.on("session_branch", (_event, ctx) => {
		const previousSessionId = state.currentSessionId;
		if (isLeadRuntime) {
			teamManager.cleanupSessionTeams("Lead session branched");
			clearLeaderTeamName(previousSessionId);
			clearTeammateWidget();
			stopTeamInboxPoller();
		}
		registry.dispose();
		resetSessionState(ctx);
		if (isLeadRuntime) {
			startLeadSessionServices();
		}
	});
	pi.on("session_shutdown", () => {
		const previousSessionId = state.currentSessionId;
		if (isLeadRuntime) {
			teamManager.cleanupSessionTeams("Lead session shutdown");
			clearLeaderTeamName(previousSessionId);
			clearTeammateWidget();
			stopTeamInboxPoller();
		}
		registry.dispose();
		stopResultWatcher();
		clearSlashSnapshots();
		slashBridge.cancelAll();
		slashBridge.dispose();
		promptTemplateBridge.cancelAll();
		promptTemplateBridge.dispose();
	});
}
