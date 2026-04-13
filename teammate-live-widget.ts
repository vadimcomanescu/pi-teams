import type { RegisteredAgent } from "./agent-registry.js";
import type { CheckedTeammate, Team } from "./team-manager.js";
import { buildTeammateSpinnerLines, type TeammateSpinnerState } from "./teammate-spinner-line.js";
import { resolveTeammateSurfaceState } from "./teammate-surface-state.js";

export const TEAMMATE_WIDGET_KEY = "team-live";
export const LEGACY_ASYNC_WIDGET_KEY = "team-async";

type CheckedTeammateLike = Pick<CheckedTeammate, "status" | "lastSummary" | "lifecycle">;

interface TeammateWidgetUI {
	setWidget(key: string, value: string[] | undefined): void;
}

export function clearTeammateWidgets(ui: TeammateWidgetUI): void {
	ui.setWidget(TEAMMATE_WIDGET_KEY, undefined);
	ui.setWidget(LEGACY_ASYNC_WIDGET_KEY, undefined);
}

export function buildLiveWidgetRenderState(input: {
	team: Team | undefined;
	checkTeammate(teamName: string, memberName: string): CheckedTeammateLike;
	resolveAgent(agentIdOrName: string): RegisteredAgent | undefined;
	nowMs: number;
	frame: number;
}): {
	lines: string[] | undefined;
	snapshot: string | null;
	shouldAnimate: boolean;
	nextFrame: number;
} {
	const team = input.team;
	if (!team || team.members.length === 0) {
		return {
			lines: undefined,
			snapshot: null,
			shouldAnimate: false,
			nextFrame: input.frame,
		};
	}

	const liveMembers = team.members.filter((member) => {
		try {
			return input.checkTeammate(team.name, member.name).status === "running";
		} catch {
			return member.status === "running";
		}
	});
	if (liveMembers.length === 0) {
		return {
			lines: undefined,
			snapshot: null,
			shouldAnimate: false,
			nextFrame: input.frame,
		};
	}

	const nextFrame = (input.frame + 1) % 1_000_000;
	let shouldAnimate = false;
	const spinnerMembers: TeammateSpinnerState[] = liveMembers.map((member) => {
		let checked: CheckedTeammateLike | undefined;
		try {
			checked = input.checkTeammate(team.name, member.name);
		} catch {
			checked = undefined;
		}
		const live = input.resolveAgent(member.agentId) ?? input.resolveAgent(member.name);
		const surface = resolveTeammateSurfaceState({
			team,
			member,
			checked,
			live,
		});
		if (surface.status === "running" && surface.activity === "running" && !surface.pendingApproval) {
			shouldAnimate = true;
		}
		return {
			name: member.name,
			role: member.agentType,
			status: surface.status,
			activity: surface.activity,
			pendingApproval: surface.pendingApproval,
			task: surface.summary ?? surface.task,
			currentTool: surface.currentTool,
			recentOutput: surface.recentOutput,
			idleSinceMs: surface.idleSinceMs,
			toolCount: surface.toolCount,
			tokens: surface.tokens,
		};
	});

	const lines = buildTeammateSpinnerLines(spinnerMembers, {
		nowMs: input.nowMs,
		frame: nextFrame,
		includeLeader: true,
	});
	return {
		lines,
		snapshot: JSON.stringify(lines),
		shouldAnimate,
		nextFrame,
	};
}
