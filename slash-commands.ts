import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { discoverAgents, discoverAgentsAll } from "./agents.js";
import { AgentManagerComponent, type ManagerResult } from "./agent-manager.js";
import { discoverAvailableSkills } from "./skills.js";
import type { TeamParamsLike } from "./team-executor.js";
import { isCoordinatorMode } from "./coordinator.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { SlashTeamResponse, SlashTeamUpdate } from "./slash-bridge.js";
import type { TaskStore, TeamTask } from "./task-store.js";
import type { Team, TeamManager } from "./team-manager.js";
import {
	applySlashUpdate,
	buildSlashInitialResult,
	failSlashResult,
	finalizeSlashResult,
} from "./slash-live-state.js";
import {
	MAX_PARALLEL,
	SLASH_RESULT_TYPE,
	SLASH_TEAM_CANCEL_EVENT,
	SLASH_TEAM_REQUEST_EVENT,
	SLASH_TEAM_RESPONSE_EVENT,
	SLASH_TEAM_STARTED_EVENT,
	SLASH_TEAM_UPDATE_EVENT,
	type TeamState,
} from "./types.js";

interface InlineConfig {
	output?: string | false;
	reads?: string[] | false;
	model?: string;
	skill?: string[] | false;
	progress?: boolean;
}

interface SlashCommandDeps {
	registry?: AgentRegistry;
	teamManager?: Pick<TeamManager, "getActiveTeam" | "getTeam">;
	createTaskStore?: (teamName: string) => TaskStore;
}

const parseInlineConfig = (raw: string): InlineConfig => {
	const config: InlineConfig = {};
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) {
			if (trimmed === "progress") config.progress = true;
			continue;
		}
		const key = trimmed.slice(0, eq).trim();
		const val = trimmed.slice(eq + 1).trim();
		switch (key) {
			case "output": config.output = val === "false" ? false : val; break;
			case "reads": config.reads = val === "false" ? false : val.split("+").filter(Boolean); break;
			case "model": config.model = val || undefined; break;
			case "skill": case "skills": config.skill = val === "false" ? false : val.split("+").filter(Boolean); break;
			case "progress": config.progress = val !== "false"; break;
		}
	}
	return config;
};

const parseAgentToken = (token: string): { name: string; config: InlineConfig } => {
	const bracket = token.indexOf("[");
	if (bracket === -1) return { name: token, config: {} };
	const end = token.lastIndexOf("]");
	return { name: token.slice(0, bracket), config: parseInlineConfig(token.slice(bracket + 1, end !== -1 ? end : undefined)) };
};

const extractExecutionFlags = (rawArgs: string): { args: string; bg: boolean; fork: boolean } => {
	let args = rawArgs.trim();
	let bg = false;
	let fork = false;

	while (true) {
		if (args.endsWith(" --bg") || args === "--bg") {
			bg = true;
			args = args === "--bg" ? "" : args.slice(0, -5).trim();
			continue;
		}
		if (args.endsWith(" --fork") || args === "--fork") {
			fork = true;
			args = args === "--fork" ? "" : args.slice(0, -7).trim();
			continue;
		}
		break;
	}

	return { args, bg, fork };
};

const makeAgentCompletions = (state: TeamState, multiAgent: boolean) => (prefix: string) => {
	const agents = discoverAgents(state.baseCwd, "both").agents;
	if (!multiAgent) {
		if (prefix.includes(" ")) return null;
		return agents.filter((a) => a.name.startsWith(prefix)).map((a) => ({ value: a.name, label: a.name }));
	}

	const lastArrow = prefix.lastIndexOf(" -> ");
	const segment = lastArrow !== -1 ? prefix.slice(lastArrow + 4) : prefix;
	if (segment.includes(" -- ") || segment.includes('"') || segment.includes("'")) return null;

	const lastWord = (prefix.match(/(\S*)$/) || ["", ""])[1];
	const beforeLastWord = prefix.slice(0, prefix.length - lastWord.length);

	if (lastWord === "->") {
		return agents.map((a) => ({ value: `${prefix} ${a.name}`, label: a.name }));
	}

	return agents.filter((a) => a.name.startsWith(lastWord)).map((a) => ({ value: `${beforeLastWord}${a.name}`, label: a.name }));
};

async function requestSlashRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	requestId: string,
	params: TeamParamsLike,
): Promise<SlashTeamResponse> {
	return new Promise((resolve, reject) => {
		let done = false;
		let started = false;

		const startTimeoutMs = 15_000;
		const startTimeout = setTimeout(() => {
			finish(() => reject(new Error(
				"Slash worker bridge did not start within 15s. Ensure the extension is loaded correctly.",
			)));
		}, startTimeoutMs);

		const onStarted = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			if ((data as { requestId?: unknown }).requestId !== requestId) return;
			started = true;
			clearTimeout(startTimeout);
			if (ctx.hasUI) ctx.ui.setStatus("worker-slash", "running...");
		};

		const onResponse = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const response = data as Partial<SlashTeamResponse>;
			if (response.requestId !== requestId) return;
			clearTimeout(startTimeout);
			finish(() => resolve(response as SlashTeamResponse));
		};

		const onUpdate = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const update = data as SlashTeamUpdate;
			if (update.requestId !== requestId) return;
			applySlashUpdate(requestId, update);
			if (!ctx.hasUI) return;
			const tool = update.currentTool ? ` ${update.currentTool}` : "";
			const count = update.toolCount ?? 0;
			ctx.ui.setStatus("worker-slash", `${count} tools${tool}`);
		};

		const onTerminalInput = ctx.hasUI
			? ctx.ui.onTerminalInput((input) => {
				if (!matchesKey(input, Key.escape)) return undefined;
				pi.events.emit(SLASH_TEAM_CANCEL_EVENT, { requestId });
				finish(() => reject(new Error("Cancelled")));
				return { consume: true };
			})
			: undefined;

		const unsubStarted = pi.events.on(SLASH_TEAM_STARTED_EVENT, onStarted);
		const unsubResponse = pi.events.on(SLASH_TEAM_RESPONSE_EVENT, onResponse);
		const unsubUpdate = pi.events.on(SLASH_TEAM_UPDATE_EVENT, onUpdate);

		const finish = (next: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(startTimeout);
			unsubStarted();
			unsubResponse();
			unsubUpdate();
			onTerminalInput?.();
			if (ctx.hasUI) ctx.ui.setStatus("worker-slash", undefined);
			next();
		};

		pi.events.emit(SLASH_TEAM_REQUEST_EVENT, { requestId, params });

		// Bridge emits STARTED synchronously during REQUEST emit.
		// If not started, no bridge received the request.
		if (!started && done) return;
		if (!started) {
			finish(() => reject(new Error(
				"No slash worker bridge responded. Ensure the pi-teams extension is loaded correctly.",
			)));
		}
	});
}

function extractSlashMessageText(content: string | Array<{ type?: string; text?: string }>): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

async function runSlashTeam(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: TeamParamsLike,
): Promise<void> {
	const requestId = randomUUID();
	const initialDetails = buildSlashInitialResult(requestId, params);
	const initialText = extractSlashMessageText(initialDetails.result.content) || "Running worker...";
	pi.sendMessage({
		customType: SLASH_RESULT_TYPE,
		content: initialText,
		display: true,
		details: initialDetails,
	});

	try {
		const response = await requestSlashRun(pi, ctx, requestId, params);
		const finalDetails = finalizeSlashResult(response);
		const text = extractSlashMessageText(response.result.content) || response.errorText || "(no output)";
		pi.sendMessage({
			customType: SLASH_RESULT_TYPE,
			content: text,
			display: false,
			details: finalDetails,
		});
		if (response.isError && ctx.hasUI) {
			ctx.ui.notify(response.errorText || "Team failed", "error");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const failedDetails = failSlashResult(requestId, params, message === "Cancelled" ? "Cancelled" : message);
		pi.sendMessage({
			customType: SLASH_RESULT_TYPE,
			content: message,
			display: false,
			details: failedDetails,
		});
		if (message === "Cancelled") {
			if (ctx.hasUI) ctx.ui.notify("Cancelled", "warning");
			return;
		}
		if (ctx.hasUI) ctx.ui.notify(message, "error");
	}
}

function summarizeLine(text?: string, maxLength = 96): string | undefined {
	if (!text) return undefined;
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function formatTaskLine(task: TeamTask): string {
	const owner = task.owner ? ` owner=${task.owner}` : "";
	return `- ${task.id} [${task.status}]${owner} ${task.subject}`;
}

function formatMemberLine(team: Team, member: Team["members"][number], registry?: AgentRegistry, tasks: TeamTask[] = []): string {
	const live = registry?.resolve(member.agentId);
	const status = live?.status ?? member.status;
	const effectiveModel = member.model ?? team.defaultModel ?? "inherits lead session model";
	const ownedTaskIds = tasks
		.filter((task) => task.owner?.toLowerCase() === member.name.toLowerCase())
		.map((task) => task.id);
	const taskSuffix = ownedTaskIds.length > 0 ? ` tasks=${ownedTaskIds.join(", ")}` : "";
	const summary = summarizeLine(live?.result ?? member.lastSummary);
	return summary
		? `- ${member.name} [${status}] model=${effectiveModel}${taskSuffix}\n  - ${summary}`
		: `- ${member.name} [${status}] model=${effectiveModel}${taskSuffix}`;
}

function buildTeamOverview(team: Team, tasks: TeamTask[], registry?: AgentRegistry): string {
	const defaultModel = team.defaultModel ?? "inherits lead session model";
	const teammateLines = team.members.length > 0
		? team.members.map((member) => formatMemberLine(team, member, registry, tasks)).join("\n")
		: "- No teammates yet";
	const taskLines = tasks.length > 0
		? tasks.map((task) => formatTaskLine(task)).join("\n")
		: "- No tasks yet";
	const header = `**Team:** ${team.name} [${team.state}]`;
	const description = team.description ? `Description: ${team.description}` : undefined;
	return [
		header,
		description,
		`Default model: ${defaultModel}`,
		"",
		"**Teammates**",
		teammateLines,
		"",
		"**Tasks**",
		taskLines,
	].filter((line): line is string => Boolean(line)).join("\n");
}

async function openAgentManager(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	const agentData = { ...discoverAgentsAll(ctx.cwd), cwd: ctx.cwd };
	const models = ctx.modelRegistry.getAvailable().map((m) => ({
		provider: m.provider,
		id: m.id,
		fullId: `${m.provider}/${m.id}`,
	}));
	const skills = discoverAvailableSkills(ctx.cwd);

	const result = await ctx.ui.custom<ManagerResult>(
		(tui, theme, _kb, done) => new AgentManagerComponent(tui, theme, agentData, models, skills, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
	);
	if (!result) return;

	if (result.action === "chain") {
		const chain = result.agents.map((name, i) => ({
			agent: name,
			...(i === 0 ? { task: result.task } : {}),
		}));
		await runSlashTeam(pi, ctx, {
			chain,
			task: result.task,
			clarify: true,
			agentScope: "both",
		});
		return;
	}

	if (result.action === "launch") {
		await runSlashTeam(pi, ctx, {
			agent: result.agent,
			task: result.task,
			clarify: !result.skipClarify,
			agentScope: "both",
		});
	} else if (result.action === "launch-chain") {
		const chainParam = result.chain.steps.map((step) => ({
			agent: step.agent,
			task: step.task || undefined,
			output: step.output,
			reads: step.reads,
			progress: step.progress,
			skill: step.skills,
			model: step.model,
		}));
		await runSlashTeam(pi, ctx, {
			chain: chainParam,
			task: result.task,
			clarify: !result.skipClarify,
			agentScope: "both",
		});
	} else if (result.action === "parallel") {
		await runSlashTeam(pi, ctx, {
			tasks: result.tasks,
			clarify: !result.skipClarify,
			agentScope: "both",
		});
	}
}

interface ParsedStep { name: string; config: InlineConfig; task?: string }

const parseAgentArgs = (
	state: TeamState,
	args: string,
	command: string,
	ctx: ExtensionContext,
): { steps: ParsedStep[]; task: string } | null => {
	const input = args.trim();
	const usage = `Usage: /${command} agent1 "task1" -> agent2 "task2"`;
	let steps: ParsedStep[];
	let sharedTask: string;
	let perStep = false;

	if (input.includes(" -> ")) {
		perStep = true;
		const segments = input.split(" -> ");
		steps = [];
		for (const seg of segments) {
			const trimmed = seg.trim();
			if (!trimmed) continue;
			let agentPart: string;
			let task: string | undefined;
			const qMatch = trimmed.match(/^(\S+(?:\[[^\]]*\])?)\s+(?:"([^"]*)"|'([^']*)')$/);
			if (qMatch) {
				agentPart = qMatch[1]!;
				task = (qMatch[2] ?? qMatch[3]) || undefined;
			} else {
				const dashIdx = trimmed.indexOf(" -- ");
				if (dashIdx !== -1) {
					agentPart = trimmed.slice(0, dashIdx).trim();
					task = trimmed.slice(dashIdx + 4).trim() || undefined;
				} else {
					agentPart = trimmed;
				}
			}
			const parsed = parseAgentToken(agentPart);
			steps.push({ ...parsed, task });
		}
		sharedTask = steps.find((s) => s.task)?.task ?? "";
	} else {
		const delimiterIndex = input.indexOf(" -- ");
		if (delimiterIndex === -1) {
			ctx.ui.notify(usage, "error");
			return null;
		}
		const agentsPart = input.slice(0, delimiterIndex).trim();
		sharedTask = input.slice(delimiterIndex + 4).trim();
		if (!agentsPart || !sharedTask) {
			ctx.ui.notify(usage, "error");
			return null;
		}
		steps = agentsPart.split(/\s+/).filter(Boolean).map((t) => parseAgentToken(t));
	}

	if (steps.length === 0) {
		ctx.ui.notify(usage, "error");
		return null;
	}
	const agents = discoverAgents(state.baseCwd, "both").agents;
	for (const step of steps) {
		if (!agents.find((a) => a.name === step.name)) {
			ctx.ui.notify(`Unknown agent: ${step.name}`, "error");
			return null;
		}
	}
	if (command === "chain" && !steps[0]?.task && (perStep || !sharedTask)) {
		ctx.ui.notify(`First step must have a task: /chain agent "task" -> agent2`, "error");
		return null;
	}
	if (command === "parallel" && !steps.some((s) => s.task) && !sharedTask) {
		ctx.ui.notify("At least one step must have a task", "error");
		return null;
	}
	return { steps, task: sharedTask };
};

export function registerSlashCommands(
	pi: ExtensionAPI,
	state: TeamState,
	deps: SlashCommandDeps = {},
): void {
	pi.registerCommand("agents", {
		description: "Open the Agents Manager",
		handler: async (_args, ctx) => {
			await openAgentManager(pi, ctx);
		},
	});

	pi.registerCommand("run", {
		description: "Run a worker directly: /run agent[output=file] task [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state, false),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const input = cleanedArgs.trim();
			const firstSpace = input.indexOf(" ");
			if (firstSpace === -1) { ctx.ui.notify("Usage: /run <agent> <task> [--bg] [--fork]", "error"); return; }
			const { name: agentName, config: inline } = parseAgentToken(input.slice(0, firstSpace));
			const task = input.slice(firstSpace + 1).trim();
			if (!task) { ctx.ui.notify("Usage: /run <agent> <task> [--bg] [--fork]", "error"); return; }

			const agents = discoverAgents(state.baseCwd, "both").agents;
			if (!agents.find((a) => a.name === agentName)) { ctx.ui.notify(`Unknown agent: ${agentName}`, "error"); return; }

			let finalTask = task;
			if (inline.reads && Array.isArray(inline.reads) && inline.reads.length > 0) {
				finalTask = `[Read from: ${inline.reads.join(", ")}]\n\n${finalTask}`;
			}
			const params: TeamParamsLike = { agent: agentName, task: finalTask, clarify: false, agentScope: "both" };
			if (inline.output !== undefined) params.output = inline.output;
			if (inline.skill !== undefined) params.skill = inline.skill;
			if (inline.model) params.model = inline.model;
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashTeam(pi, ctx, params);
		},
	});

	pi.registerCommand("chain", {
		description: "Run agents in sequence: /chain scout \"task\" -> planner [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state, true),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const parsed = parseAgentArgs(state, cleanedArgs, "chain", ctx);
			if (!parsed) return;
			const chain = parsed.steps.map(({ name, config, task: stepTask }, i) => ({
				agent: name,
				...(stepTask ? { task: stepTask } : i === 0 && parsed.task ? { task: parsed.task } : {}),
				...(config.output !== undefined ? { output: config.output } : {}),
				...(config.reads !== undefined ? { reads: config.reads } : {}),
				...(config.model ? { model: config.model } : {}),
				...(config.skill !== undefined ? { skill: config.skill } : {}),
				...(config.progress !== undefined ? { progress: config.progress } : {}),
			}));
			const params: TeamParamsLike = { chain, task: parsed.task, clarify: false, agentScope: "both" };
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashTeam(pi, ctx, params);
		},
	});

	pi.registerCommand("parallel", {
		description: "Run agents in parallel: /parallel scout \"task1\" -> reviewer \"task2\" [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state, true),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const parsed = parseAgentArgs(state, cleanedArgs, "parallel", ctx);
			if (!parsed) return;
			if (parsed.steps.length > MAX_PARALLEL) { ctx.ui.notify(`Max ${MAX_PARALLEL} parallel tasks`, "error"); return; }
			const tasks = parsed.steps.map(({ name, config, task: stepTask }) => ({
				agent: name,
				task: stepTask ?? parsed.task,
				...(config.output !== undefined ? { output: config.output } : {}),
				...(config.reads !== undefined ? { reads: config.reads } : {}),
				...(config.model ? { model: config.model } : {}),
				...(config.skill !== undefined ? { skill: config.skill } : {}),
				...(config.progress !== undefined ? { progress: config.progress } : {}),
			}));
			const params: TeamParamsLike = { tasks, clarify: false, agentScope: "both" };
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashTeam(pi, ctx, params);
		},
	});

	pi.registerShortcut("ctrl+shift+t", {
		handler: async (ctx) => {
			await openAgentManager(pi, ctx);
		},
	});

	const requireLeadSession = (ctx: ExtensionContext): boolean => {
		if (isCoordinatorMode()) return true;
		if (ctx.hasUI) ctx.ui.notify("This command is only available in the lead session.", "warning");
		return false;
	};

	pi.registerCommand("team", {
		description: "Show the active team, teammates, and shared tasks: /team [team-name]",
		handler: async (args, ctx) => {
			if (!requireLeadSession(ctx)) return;
			if (!deps.teamManager || !deps.createTaskStore) {
				if (ctx.hasUI) ctx.ui.notify("Team visibility is not available in this session.", "warning");
				return;
			}
			const requestedTeamName = args.trim();
			const team = requestedTeamName
				? deps.teamManager.getTeam(requestedTeamName)
				: deps.teamManager.getActiveTeam();
			if (!team) {
				const message = requestedTeamName
					? `Team not found: ${requestedTeamName}`
					: "No active team in this lead session";
				if (ctx.hasUI) ctx.ui.notify(message, "info");
				return;
			}
			const tasks = deps.createTaskStore(team.name).listTasks();
			pi.sendMessage(
				{ customType: "team-notify", content: buildTeamOverview(team, tasks, deps.registry), display: true },
				{ triggerTurn: false },
			);
		},
	});
	pi.registerCommand("workers", {
		description: "List running workers in the current lead session",
		handler: async (_args, ctx) => {
			if (!requireLeadSession(ctx)) return;
			if (!deps.registry) {
				if (ctx.hasUI) ctx.ui.notify("Worker registry is not available in this session.", "warning");
				return;
			}
			const all = deps.registry.getAll();
			if (all.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("No workers registered", "info");
				return;
			}
			const lines = all.map((a) => {
				const name = a.name ? `${a.name} (${a.id})` : a.id;
				const duration = a.status === "running"
					? ` ${Math.round((Date.now() - a.startTime) / 1000)}s`
					: "";
				return `${a.status === "running" ? "🔄" : a.status === "completed" ? "✅" : "❌"} ${name} [${a.status}]${duration}`;
			});
			pi.sendMessage(
				{ customType: "team-notify", content: `**Workers:**\n${lines.join("\n")}`, display: true },
				{ triggerTurn: false },
			);
		},
	});

	pi.registerCommand("stop-all", {
		description: "Stop all running workers in the current lead session",
		handler: async (_args, ctx) => {
			if (!requireLeadSession(ctx)) return;
			if (!deps.registry) {
				if (ctx.hasUI) ctx.ui.notify("Worker registry is not available in this session.", "warning");
				return;
			}
			const running = deps.registry.getRunning();
			if (running.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("No workers running", "info");
				return;
			}
			deps.registry.stopAll();
			if (ctx.hasUI) ctx.ui.notify(`Stopped ${running.length} worker(s)`, "info");
		},
	});
}
