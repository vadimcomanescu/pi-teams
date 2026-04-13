import type { AgentStatus, RegisteredAgent } from "./agent-registry.js";
import { summarizeMeaningfulLine, summarizeMeaningfulRecentOutput } from "./activity-summary.js";
import { describeTeammateLifecycle, type TeammateLifecycle } from "./teammate-lifecycle.js";
import type { CheckedTeammate, Team, TeamMember, TeammateMode } from "./team-manager.js";

export interface TeammateSurfaceState {
	displayName: string;
	status: AgentStatus;
	mode: TeammateMode;
	effectiveModel?: string;
	lifecycle: TeammateLifecycle;
	labels: string[];
	summary?: string;
	availabilityText: string;
	activity: "running" | "idle";
	pendingApproval: boolean;
	currentTool?: string;
	recentOutput?: string[];
	task?: string;
	toolCount?: number;
	tokens?: number;
	idleSinceMs?: number;
}

function getLifecycleStateLabels(input: {
	team: Team;
	member: TeamMember;
	status: AgentStatus;
	lifecycle: TeammateLifecycle;
}): string[] {
	const labels: string[] = [];
	if (input.team.state !== "active") labels.push(input.team.state);
	if (input.status === "running" && input.member.pendingShutdownRequestId) labels.push("awaiting approval");
	if (input.status === "running") {
		labels.push(input.lifecycle.activity === "idle" ? "idle" : "running");
	} else {
		labels.push(input.status);
	}
	return labels;
}

function describeAvailability(team: Team, lifecycle: TeammateLifecycle, status: AgentStatus): string {
	if (team.state !== "active") return "Not available, this team is not active";
	if (lifecycle.canQueueFollowUp) return "Running now and can take follow-up work";
	if (status === "running") return "Running now, but not directly reachable";
	if (lifecycle.canResume) return "Idle, can be resumed";
	return "Finished, start a new teammate to continue";
}

function pickSummary(input: {
	status: AgentStatus;
	live?: RegisteredAgent;
	checked?: CheckedTeammate;
	member: TeamMember;
	maxLength: number;
}): string | undefined {
	const recentOutput = summarizeMeaningfulRecentOutput(input.live?.recentOutput, input.maxLength);
	const currentTool = summarizeMeaningfulLine(input.live?.currentTool, input.maxLength);
	const checkedSummary = summarizeMeaningfulLine(input.checked?.lastSummary, input.maxLength);
	const liveResult = summarizeMeaningfulLine(input.live?.result, input.maxLength);
	const memberSummary = summarizeMeaningfulLine(input.member.lastSummary, input.maxLength);
	const task = summarizeMeaningfulLine(input.live?.task, input.maxLength);
	if (input.status === "running") {
		return recentOutput ?? currentTool ?? checkedSummary ?? liveResult ?? memberSummary ?? task;
	}
	return checkedSummary ?? liveResult ?? memberSummary ?? recentOutput ?? currentTool ?? task;
}

export function resolveTeammateSurfaceState(input: {
	team: Team;
	member: TeamMember;
	checked?: CheckedTeammate;
	live?: RegisteredAgent;
	maxSummaryLength?: number;
}): TeammateSurfaceState {
	const status = input.checked?.status ?? input.live?.status ?? input.member.status;
	const lifecycle = input.checked?.lifecycle ?? describeTeammateLifecycle({
		status,
		sessionFile: input.live?.sessionFile,
		acceptsFollowUps: Boolean(input.live?.rpcHandle),
		active: input.team.state === "active",
		isActive: input.member.isActive,
	});
	const mode = input.checked?.mode ?? input.member.mode ?? "default";
	return {
		displayName: input.member.name.startsWith("@") ? input.member.name : `@${input.member.name}`,
		status,
		mode,
		effectiveModel: input.checked?.effectiveModel ?? input.member.model ?? input.team.defaultModel,
		lifecycle,
		labels: getLifecycleStateLabels({
			team: input.team,
			member: input.member,
			status,
			lifecycle,
		}),
		summary: pickSummary({
			status,
			live: input.live,
			checked: input.checked,
			member: input.member,
			maxLength: input.maxSummaryLength ?? 88,
		}),
		availabilityText: describeAvailability(input.team, lifecycle, status),
		activity: input.checked?.lifecycle.activity ?? lifecycle.activity,
		pendingApproval: Boolean(input.member.pendingShutdownRequestId),
		currentTool: input.live?.currentTool,
		recentOutput: input.live?.recentOutput,
		task: input.live?.task,
		toolCount: input.live?.toolCount,
		tokens: input.live?.tokens,
		idleSinceMs: lifecycle.activity === "idle" ? input.member.updatedAt : undefined,
	};
}
