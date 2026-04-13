export interface TeammateSpinnerState {
	name: string;
	status: "running" | "completed" | "failed" | "stopped" | "timed_out";
	activity: "running" | "idle";
	pendingApproval?: boolean;
	task?: string;
	currentTool?: string;
	recentOutput?: string[];
	idleSinceMs?: number;
	toolCount?: number;
	tokens?: number;
}

import { summarizeMeaningfulLine, summarizeMeaningfulRecentOutput } from "./activity-summary.js";

interface BuildSpinnerOptions {
	nowMs: number;
	frame: number;
	maxMembers?: number;
	columns?: number;
	includeLeader?: boolean;
	selectionMode?: boolean;
	selectedIndex?: number;
	foregroundedName?: string;
	leaderVerb?: string;
	leaderTokenCount?: number;
	leaderIdleText?: string;
}

const ACTIVE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)));
}

function resolveColumns(columns: number | undefined): number {
	if (typeof columns === "number" && Number.isFinite(columns) && columns > 0) return Math.floor(columns);
	if (typeof process.stdout.columns === "number" && Number.isFinite(process.stdout.columns) && process.stdout.columns > 0) {
		return Math.floor(process.stdout.columns);
	}
	return Number.POSITIVE_INFINITY;
}

function truncateToWidth(text: string, width: number): string {
	if (!Number.isFinite(width) || text.length <= width) return text;
	if (width <= 0) return "";
	if (width === 1) return "…";
	return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function truncateMiddle(text: string, width: number): string {
	if (!Number.isFinite(width) || text.length <= width) return text;
	if (width <= 0) return "";
	if (width === 1) return "…";
	const head = Math.max(1, Math.ceil((width - 1) / 2));
	const tail = Math.max(0, Math.floor((width - 1) / 2));
	return `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ""}`;
}

function resolveMaxNameLength(columns: number): number {
	if (!Number.isFinite(columns)) return 24;
	if (columns <= 40) return 10;
	if (columns <= 56) return 14;
	if (columns <= 72) return 18;
	return 24;
}

function formatIdleDuration(ms: number): string {
	const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
	const roundedMs = safeMs < 60_000
		? Math.floor(safeMs / 5_000) * 5_000
		: safeMs < 10 * 60_000
			? Math.floor(safeMs / 30_000) * 30_000
			: Math.floor(safeMs / 60_000) * 60_000;
	const seconds = Math.floor(roundedMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

function summarizeActivity(member: TeammateSpinnerState): string {
	const latestOutput = summarizeMeaningfulRecentOutput(member.recentOutput, 96);
	if (latestOutput) return latestOutput;
	const tool = summarizeMeaningfulLine(member.currentTool, 96);
	if (tool) return tool;
	const task = summarizeMeaningfulLine(member.task, 96);
	if (task) return task;
	return "Working";
}

function buildLeaderLine(options: BuildSpinnerOptions): string {
	const selectionMode = options.selectionMode === true;
	const selected = selectionMode && options.selectedIndex === -1;
	const foregrounded = options.foregroundedName === "team-lead" || options.foregroundedName === "Lead";
	const highlighted = selected || foregrounded;
	const pointer = selectionMode ? (selected ? "›" : " ") : " ";
	const treePrefix = highlighted ? "╒═" : "┌─";
	const columns = resolveColumns(options.columns);
	let line = `${pointer} ${treePrefix} Lead`;

	if (highlighted) {
		if (options.leaderVerb) {
			line += `: ${options.leaderVerb.endsWith("…") ? options.leaderVerb : `${options.leaderVerb}…`}`;
		} else if (options.leaderIdleText) {
			line += `: ${options.leaderIdleText}`;
		}
	}

	const tokenSegment = typeof options.leaderTokenCount === "number" && options.leaderTokenCount > 0
		? ` · ${formatNumber(options.leaderTokenCount)} tokens`
		: undefined;
	if (tokenSegment && line.length + tokenSegment.length <= columns) {
		line += tokenSegment;
	}

	return truncateToWidth(line, columns);
}

function buildTeammateLine(
	member: TeammateSpinnerState,
	index: number,
	visibleLength: number,
	totalLength: number,
	options: BuildSpinnerOptions,
): string {
	const selectionMode = options.selectionMode === true;
	const selected = selectionMode && options.selectedIndex === index;
	const foregrounded = options.foregroundedName === member.name;
	const highlighted = selected || foregrounded;
	const pointer = selectionMode ? (selected ? "›" : " ") : " ";
	const isLast = index === visibleLength - 1 && totalLength <= visibleLength;
	const treePrefix = highlighted
		? (isLast ? "╘═" : "╞═")
		: (isLast ? "└─" : "├─");
	const columns = resolveColumns(options.columns);
	const rawDisplayName = member.name.startsWith("@") ? member.name : `@${member.name}`;
	const displayName = truncateMiddle(rawDisplayName, resolveMaxNameLength(columns));
	const prefix = `${pointer} ${treePrefix} ${displayName}: `;

	let stateText = "Stopped";
	if (member.pendingApproval) {
		stateText = "Awaiting approval";
	} else if (member.status === "running" && member.activity === "idle") {
		stateText = typeof member.idleSinceMs === "number"
			? `Idle for ${formatIdleDuration(options.nowMs - member.idleSinceMs)}`
			: "Idle";
	} else if (member.status === "running") {
		const frame = highlighted
			? "•"
			: (ACTIVE_SPINNER_FRAMES[Math.abs(options.frame + index) % ACTIVE_SPINNER_FRAMES.length] ?? "⠋");
		const activity = summarizeActivity(member);
		stateText = `${frame} ${activity.endsWith("…") ? activity : `${activity}…`}`;
	} else if (member.status === "completed") {
		stateText = "Completed";
	} else if (member.status === "failed") {
		stateText = "Failed";
	} else if (member.status === "timed_out") {
		stateText = "Timed out";
	}

	let line = truncateToWidth(`${prefix}${stateText}`.trimEnd(), columns);
	const statSegments = [
		typeof member.toolCount === "number" && member.toolCount > 0
			? ` · ${member.toolCount} tool ${member.toolCount === 1 ? "use" : "uses"}`
			: undefined,
		typeof member.tokens === "number" && member.tokens > 0
			? ` · ${formatNumber(member.tokens)} tokens`
			: undefined,
	].filter((segment): segment is string => Boolean(segment));

	for (const segment of statSegments) {
		if (line.length + segment.length > columns) break;
		line += segment;
	}
	return truncateToWidth(line.trimEnd(), columns);
}

export function buildTeammateSpinnerLines(
	members: TeammateSpinnerState[],
	options: BuildSpinnerOptions,
): string[] {
	if (members.length === 0) return [];
	const maxMembers = options.maxMembers ?? 6;
	const visible = members.slice(0, maxMembers);
	const lines: string[] = [];

	if (options.includeLeader !== false) {
		lines.push(buildLeaderLine(options));
	}

	for (let index = 0; index < visible.length; index++) {
		lines.push(buildTeammateLine(visible[index], index, visible.length, members.length, options));
	}

	if (members.length > maxMembers) {
		lines.push(`└─ … and ${members.length - maxMembers} more`);
	}

	return lines;
}
