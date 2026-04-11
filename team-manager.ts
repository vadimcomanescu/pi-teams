import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RegisteredAgent, AgentRegistry, AgentStatus } from "./agent-registry.js";
import { withFileLock, writeJsonAtomically } from "./state-file-utils.js";
import { clearLeaderTeamName, getLeaderTeamName, setLeaderTeamName } from "./leader-team-state.js";
import { clearSessionCreatedTeams, getSessionCreatedTeams, registerTeamForSessionCleanup, unregisterTeamForSessionCleanup } from "./session-created-teams.js";
import { TaskStore, type UnassignTasksForOwnerResult } from "./task-store.js";
import { describeTeammateLifecycle, type TeammateLifecycle } from "./teammate-lifecycle.js";

export type TeamState = "active" | "shutdown" | "orphaned";

export interface TeamMember {
	name: string;
	agentId: string;
	agentType: string;
	model?: string;
	status: AgentStatus;
	cwd: string;
	lastSummary?: string;
	pendingShutdownRequestId?: string;
	updatedAt: number;
}

export interface Team {
	name: string;
	description?: string;
	leadSessionId: string;
	defaultModel?: string;
	members: TeamMember[];
	createdAt: number;
	state: TeamState;
	shutdownAt?: number;
}

export interface CheckedTeammate {
	teamName: string;
	effectiveModel?: string;
	status: AgentStatus;
	lastSummary?: string;
	member: TeamMember;
	state: TeamState;
	sessionFile?: string;
	lifecycle: TeammateLifecycle;
}

export interface DeleteTeamResult {
	teamName?: string;
	noop: boolean;
	removedPaths: string[];
	leadStateCleared: boolean;
}

export interface SessionCleanupResult {
	teamNames: string[];
	cleanedTeams: string[];
	failures: Array<{ teamName: string; step: "stop" | "delete"; message: string }>;
}

export interface ShutdownResponseOutcome {
	approved: boolean;
	team: Team;
	member: TeamMember;
	summary: string;
	reason?: string;
	unassigned: UnassignTasksForOwnerResult;
}

export type TaskMutationActor =
	| { kind: "lead" }
	| { kind: "teammate"; name: string };

interface TeamManagerOptions {
	registry: AgentRegistry;
	getCurrentSessionId: () => string | null;
	getCurrentTeammateTeamName?: () => string | null;
	getCurrentTeammateName?: () => string | null;
	rootDir?: string;
	now?: () => number;
	onMemberStopped?: (member: TeamMember, team: Team, reason: string | undefined, unassigned: UnassignTasksForOwnerResult) => void;
}

export class TeamConfigError extends Error {}

function sanitizeTeamName(teamName: string): string {
	return teamName.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function validateSanitizedTeamName(teamName: string): string {
	const sanitized = sanitizeTeamName(teamName);
	if (!sanitized || sanitized === "." || sanitized === "..") {
		throw new Error(`Unsafe team name: ${teamName}`);
	}
	return sanitized;
}

export class TeamManager {
	private readonly options: TeamManagerOptions;
	private readonly rootDir: string;
	private readonly now: () => number;
	private readonly onMemberStopped?: TeamManagerOptions["onMemberStopped"];
	private readonly rootLockPath: string;

	constructor(options: TeamManagerOptions) {
		this.options = options;
		this.rootDir = path.resolve(options.rootDir ?? path.join(os.homedir(), ".pi", "teams"));
		this.now = options.now ?? (() => Date.now());
		this.onMemberStopped = options.onMemberStopped;
		this.rootLockPath = path.join(this.rootDir, ".teams-root");
		fs.mkdirSync(this.rootDir, { recursive: true });
	}

	getRootDir(): string {
		return this.rootDir;
	}

	private resolveTeamPath(teamName: string, fileName?: string): string {
		const sanitized = validateSanitizedTeamName(teamName);
		const resolved = fileName
			? path.resolve(this.rootDir, sanitized, fileName)
			: path.resolve(this.rootDir, sanitized);
		const relative = path.relative(this.rootDir, resolved);
		if (!relative || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`Resolved team path escapes teams root: ${teamName}`);
		}
		return resolved;
	}

	getTeamDir(teamName: string): string {
		return this.resolveTeamPath(teamName);
	}

	getConfigPath(teamName: string): string {
		return this.resolveTeamPath(teamName, "config.json");
	}

	getTasksPath(teamName: string): string {
		return this.resolveTeamPath(teamName, "tasks.json");
	}

	private withRootLock<T>(callback: () => T): T {
		return withFileLock(this.rootLockPath, callback);
	}

	private readTeamFile(configPath: string): Team | undefined {
		if (!fs.existsSync(configPath)) return undefined;
		try {
			const raw = fs.readFileSync(configPath, "utf-8");
			const parsed = JSON.parse(raw) as Team;
			if (!parsed.name || !parsed.leadSessionId || !Array.isArray(parsed.members) || !parsed.state) {
				throw new Error("missing required team fields");
			}
			return parsed;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new TeamConfigError(`Corrupt team config: ${configPath}. ${message}`);
		}
	}

	private safeReadTeamFile(configPath: string): Team | undefined {
		try {
			return this.readTeamFile(configPath);
		} catch (error) {
			if (error instanceof TeamConfigError) {
				return undefined;
			}
			throw error;
		}
	}

	private writeTeam(team: Team): void {
		writeJsonAtomically(this.getConfigPath(team.name), team);
	}

	private listConfigPaths(): string[] {
		if (!fs.existsSync(this.rootDir)) return [];
		return fs.readdirSync(this.rootDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(this.rootDir, entry.name, "config.json"))
			.filter((configPath) => fs.existsSync(configPath));
	}

	private teamDirExists(teamName: string): boolean {
		return fs.existsSync(this.getTeamDir(teamName));
	}

	listTeams(): Team[] {
		return this.listConfigPaths()
			.map((configPath) => this.safeReadTeamFile(configPath))
			.filter((team): team is Team => Boolean(team));
	}

	getTeam(teamName: string): Team | undefined {
		return this.readTeamFile(this.getConfigPath(teamName));
	}

	getActiveTeam(): Team | undefined {
		const sessionId = this.options.getCurrentSessionId();
		if (!sessionId) return undefined;
		return this.listTeams().find((team) => team.leadSessionId === sessionId && team.state === "active");
	}

	private isTeammateRuntime(): boolean {
		return Boolean(this.options.getCurrentTeammateTeamName?.());
	}

	private rememberLeadTeamContext(teamName: string): void {
		if (this.isTeammateRuntime()) return;
		setLeaderTeamName(this.requireLeadSessionId(), teamName);
	}

	private clearLeadTeamContext(teamName?: string): void {
		const sessionId = this.options.getCurrentSessionId();
		if (!sessionId) return;
		const rememberedTeamName = getLeaderTeamName(sessionId);
		if (!teamName || rememberedTeamName === teamName) {
			clearLeaderTeamName(sessionId);
		}
	}

	private resolveRememberedLeadTeam(): Team | undefined {
		const sessionId = this.options.getCurrentSessionId();
		const rememberedTeamName = getLeaderTeamName(sessionId);
		if (!rememberedTeamName) return undefined;
		const team = this.safeReadTeamFile(this.getConfigPath(rememberedTeamName));
		if (!team || !sessionId || team.leadSessionId !== sessionId) {
			this.clearLeadTeamContext(rememberedTeamName);
			return undefined;
		}
		return team;
	}

	resolveCurrentTeamName(): string | undefined {
		const teammateTeamName = this.options.getCurrentTeammateTeamName?.() ?? undefined;
		if (teammateTeamName) return teammateTeamName;
		const rememberedLeadTeam = this.resolveRememberedLeadTeam();
		if (rememberedLeadTeam) return rememberedLeadTeam.name;
		const activeTeam = this.getActiveTeam();
		if (activeTeam) {
			this.rememberLeadTeamContext(activeTeam.name);
			return activeTeam.name;
		}
		return undefined;
	}

	private resolveRequestedTeamName(teamName?: string): string {
		if (teamName && teamName.trim()) return teamName;
		const current = this.resolveCurrentTeamName();
		if (!current) {
			throw new Error("No current team context. Provide team_name explicitly.");
		}
		return current;
	}

	resolveTeamName(teamName?: string): string {
		return this.resolveRequestedTeamName(teamName);
	}

	private requireLeadSessionId(): string {
		const sessionId = this.options.getCurrentSessionId();
		if (!sessionId) {
			throw new Error("Team operations require an active lead session.");
		}
		return sessionId;
	}

	assertLeadControl(teamName?: string): Team {
		const resolvedTeamName = this.resolveRequestedTeamName(teamName);
		const team = this.getTeam(resolvedTeamName);
		if (!team) {
			throw new Error(`Team not found: ${resolvedTeamName}`);
		}
		const sessionId = this.requireLeadSessionId();
		if (team.leadSessionId !== sessionId) {
			throw new Error(`Only the lead session may mutate team "${resolvedTeamName}".`);
		}
		return team;
	}

	assertTeamAccess(teamName?: string): Team {
		const resolvedTeamName = this.resolveRequestedTeamName(teamName);
		const team = this.getTeam(resolvedTeamName);
		if (!team) {
			throw new Error(`Team not found: ${resolvedTeamName}`);
		}
		const teammateTeamName = this.options.getCurrentTeammateTeamName?.() ?? null;
		if (teammateTeamName) {
			if (team.name !== teammateTeamName) {
				throw new Error(`Teammates may only access their own team: ${teammateTeamName}`);
			}
			return team;
		}
		return this.assertLeadControl(resolvedTeamName);
	}

	assertTaskMutationAccess(teamName?: string): { team: Team; actor: TaskMutationActor } {
		const teammateTeamName = this.options.getCurrentTeammateTeamName?.() ?? null;
		if (teammateTeamName) {
			const team = this.assertTeamAccess(teamName);
			if (team.state !== "active") {
				throw new Error(`Team "${team.name}" is not active.`);
			}
			const teammateName = this.options.getCurrentTeammateName?.() ?? null;
			if (!teammateName) {
				throw new Error("Teammate identity is unavailable for task mutation.");
			}
			return { team, actor: { kind: "teammate", name: teammateName } };
		}
		return { team: this.assertLeadControl(teamName), actor: { kind: "lead" } };
	}

	bootstrap(): void {
		this.withRootLock(() => {
			const sessionId = this.options.getCurrentSessionId();
			for (const configPath of this.listConfigPaths()) {
				const team = this.safeReadTeamFile(configPath);
				if (!team || team.state !== "active") continue;
				const hasRunningMember = team.members.some((member) => {
					const live = this.options.registry.resolve(member.agentId);
					return live?.status === "running";
				});
				if (team.leadSessionId !== sessionId || !hasRunningMember) {
					team.state = team.leadSessionId === sessionId ? "shutdown" : "orphaned";
					team.shutdownAt = this.now();
					for (const member of team.members) {
						if (member.status === "running") {
							member.status = team.state === "orphaned" ? "failed" : "stopped";
							member.updatedAt = this.now();
						}
					}
					this.writeTeam(team);
				}
			}
			const activeTeam = this.getActiveTeam();
			if (activeTeam) {
				this.rememberLeadTeamContext(activeTeam.name);
			}
		});
	}

	private buildAvailableTeamName(requestedTeamName: string): string {
		validateSanitizedTeamName(requestedTeamName);
		if (!this.teamDirExists(requestedTeamName)) {
			return requestedTeamName;
		}
		for (let suffix = 2; suffix < 10_000; suffix++) {
			const candidate = `${requestedTeamName}-${suffix}`;
			validateSanitizedTeamName(candidate);
			if (!this.teamDirExists(candidate)) {
				return candidate;
			}
		}
		throw new Error(`Could not generate an available team name for: ${requestedTeamName}`);
	}

	createTeam(input: { team_name: string; description?: string; default_model?: string }): Team {
		return this.withRootLock(() => {
			const sessionId = this.requireLeadSessionId();
			const requestedTeamName = input.team_name.trim();
			if (!requestedTeamName) {
				throw new Error("team_name is required");
			}
			validateSanitizedTeamName(requestedTeamName);
			const activeTeam = this.getActiveTeam();
			if (activeTeam) {
				throw new Error(`Only one active team is allowed per lead session. Active team: ${activeTeam.name}`);
			}
			const teamName = this.buildAvailableTeamName(requestedTeamName);
			const now = this.now();
			const team: Team = {
				name: teamName,
				description: input.description,
				leadSessionId: sessionId,
				defaultModel: input.default_model,
				members: [],
				createdAt: now,
				state: "active",
			};
			this.writeTeam(team);
			this.rememberLeadTeamContext(team.name);
			registerTeamForSessionCleanup(sessionId, team.name);
			return team;
		});
	}

	private findMemberIndexByName(team: Team, agentName: string): number {
		for (let index = team.members.length - 1; index >= 0; index--) {
			if (team.members[index]?.name.toLowerCase() === agentName.toLowerCase()) {
				return index;
			}
		}
		return -1;
	}

	registerTeammate(teamName: string, member: Omit<TeamMember, "updatedAt">): TeamMember {
		return this.withRootLock(() => {
			const team = this.assertLeadControl(teamName);
			if (team.state !== "active") {
				throw new Error(`Team "${teamName}" is not active.`);
			}
			const existingLive = this.options.registry.resolve(member.name);
			if (existingLive?.status === "running" && existingLive.id !== member.agentId) {
				throw new Error(`Agent name already in use by a running agent: ${member.name}`);
			}
			const existingIndex = this.findMemberIndexByName(team, member.name);
			if (existingIndex !== -1 && team.members[existingIndex]?.status === "running" && team.members[existingIndex]?.agentId !== member.agentId) {
				throw new Error(`Teammate name already active in team "${teamName}": ${member.name}`);
			}
			const persisted: TeamMember = {
				...member,
				updatedAt: this.now(),
				lastSummary: existingIndex !== -1 ? team.members[existingIndex]?.lastSummary : member.lastSummary,
				pendingShutdownRequestId: undefined,
			};
			if (existingIndex !== -1) {
				team.members[existingIndex] = persisted;
			} else {
				team.members.push(persisted);
			}
			this.writeTeam(team);
			return persisted;
		});
	}

	private resolveLiveTeammate(member: TeamMember): RegisteredAgent | undefined {
		return this.options.registry.resolve(member.agentId) ?? this.options.registry.resolve(member.name);
	}

	private unassignTasksForMember(teamName: string, member: Pick<TeamMember, "name" | "agentId">): UnassignTasksForOwnerResult {
		return new TaskStore(teamName, this.getTasksPath(teamName)).unassignTasksForOwner(member.name, {
			aliases: [member.agentId],
		});
	}

	unassignOpenTasksForAgent(agentId: string): UnassignTasksForOwnerResult {
		return this.withRootLock(() => {
			for (const team of this.listTeams()) {
				const member = team.members.find((entry) => entry.agentId === agentId);
				if (!member) continue;
				return this.unassignTasksForMember(team.name, member);
			}
			return { unassignedTasks: [] };
		});
	}

	checkTeammate(teamName: string | undefined, agentName: string): CheckedTeammate {
		const resolvedTeamName = this.resolveRequestedTeamName(teamName);
		const team = this.getTeam(resolvedTeamName);
		if (!team) {
			throw new Error(`Team not found: ${resolvedTeamName}`);
		}
		const memberIndex = this.findMemberIndexByName(team, agentName);
		const member = memberIndex !== -1 ? team.members[memberIndex] : undefined;
		if (!member) {
			throw new Error(`Teammate not found in team "${resolvedTeamName}": ${agentName}`);
		}
		const live = this.resolveLiveTeammate(member);
		const resolvedStatus = member.status !== "running" ? member.status : (live?.status ?? member.status);
		return {
			teamName: team.name,
			effectiveModel: member.model ?? team.defaultModel,
			status: resolvedStatus,
			lastSummary: live?.result ?? member.lastSummary,
			member: live ? { ...member, agentId: live.id, status: resolvedStatus } : member,
			state: team.state,
			sessionFile: live?.sessionFile,
			lifecycle: describeTeammateLifecycle({
				status: resolvedStatus,
				sessionFile: live?.sessionFile,
				acceptsFollowUps: Boolean(live?.rpcHandle),
				active: team.state === "active",
			}),
		};
	}

	private shouldIgnoreTerminalUpdate(current: AgentStatus, next: AgentStatus, teamState: TeamState): boolean {
		if (current === next) return false;
		if (current === "running") return false;
		if (teamState === "shutdown" && current === "stopped") return true;
		if (current === "stopped" || current === "timed_out") return true;
		return true;
	}

	recordTeammateStatus(agentId: string, status: AgentStatus, lastSummary?: string): void {
		this.withRootLock(() => {
			for (const team of this.listTeams()) {
				const member = team.members.find((entry) => entry.agentId === agentId);
				if (!member) continue;
				if (this.shouldIgnoreTerminalUpdate(member.status, status, team.state)) {
					if (!member.lastSummary && lastSummary) {
						member.lastSummary = lastSummary;
						member.updatedAt = this.now();
						this.writeTeam(team);
					}
					return;
				}
				member.status = status;
				member.updatedAt = this.now();
				member.pendingShutdownRequestId = undefined;
				if (lastSummary !== undefined) {
					member.lastSummary = lastSummary;
				}
				if (status === "stopped" || status === "timed_out" || status === "failed") {
					this.unassignTasksForMember(team.name, member);
				}
				this.writeTeam(team);
				return;
			}
		});
	}

	recordShutdownRequest(agentId: string, requestId: string, summary?: string): void {
		this.withRootLock(() => {
			for (const team of this.listTeams()) {
				const member = team.members.find((entry) => entry.agentId === agentId);
				if (!member) continue;
				member.pendingShutdownRequestId = requestId;
				member.lastSummary = summary?.trim()
					? `Graceful shutdown requested: ${summary.trim()}`
					: "Graceful shutdown requested by lead";
				member.updatedAt = this.now();
				this.writeTeam(team);
				return;
			}
			throw new Error(`Teammate not found for shutdown request: ${agentId}`);
		});
	}

	clearPendingShutdownRequest(agentId: string, requestId?: string): void {
		this.withRootLock(() => {
			for (const team of this.listTeams()) {
				const member = team.members.find((entry) => entry.agentId === agentId);
				if (!member) continue;
				if (requestId && member.pendingShutdownRequestId !== requestId) {
					return;
				}
				member.pendingShutdownRequestId = undefined;
				member.updatedAt = this.now();
				this.writeTeam(team);
				return;
			}
		});
	}

	validateCurrentTeammateShutdownRequest(requestId: string): void {
		this.withRootLock(() => {
			const teamName = this.options.getCurrentTeammateTeamName?.();
			const teammateName = this.options.getCurrentTeammateName?.();
			if (!teamName || !teammateName) {
				throw new Error("shutdown_response is only available inside a teammate runtime.");
			}
			const team = this.getTeam(teamName);
			if (!team) {
				throw new Error(`Team not found: ${teamName}`);
			}
			if (team.state !== "active") {
				throw new Error(`Team "${team.name}" is not active.`);
			}
			const memberIndex = this.findMemberIndexByName(team, teammateName);
			if (memberIndex === -1) {
				throw new Error(`Teammate not found in team "${team.name}": ${teammateName}`);
			}
			const member = team.members[memberIndex]!;
			if (member.pendingShutdownRequestId !== requestId) {
				throw new Error(`Unknown shutdown request for teammate "${member.name}": ${requestId}`);
			}
		});
	}

	handleShutdownResponseForAgent(agentId: string, input: {
		requestId: string;
		approve: boolean;
		reason?: string;
		summary?: string;
	}): ShutdownResponseOutcome {
		return this.withRootLock(() => {
			for (const team of this.listTeams()) {
				const member = team.members.find((entry) => entry.agentId === agentId);
				if (!member) continue;
				if (team.state !== "active") {
					throw new Error(`Team "${team.name}" is not active.`);
				}
				if (member.pendingShutdownRequestId !== input.requestId) {
					throw new Error(`Unknown shutdown request for teammate "${member.name}": ${input.requestId}`);
				}
				member.pendingShutdownRequestId = undefined;
				member.updatedAt = this.now();
				if (!input.approve) {
					const reason = input.reason?.trim();
					if (!reason) {
						throw new Error("Rejected shutdown responses require a non-empty reason.");
					}
					member.lastSummary = `Graceful shutdown rejected: ${reason}`;
					this.writeTeam(team);
					return {
						approved: false,
						team,
						member: { ...member },
						summary: member.lastSummary,
						reason,
						unassigned: { unassignedTasks: [] },
					};
				}
				const unassigned = this.unassignTasksForMember(team.name, member);
				member.status = "stopped";
				member.lastSummary = input.summary?.trim() || "Graceful shutdown approved";
				this.writeTeam(team);
				return {
					approved: true,
					team,
					member: { ...member },
					summary: member.lastSummary,
					unassigned,
				};
			}
			throw new Error(`Teammate not found for shutdown response: ${agentId}`);
		});
	}

	resolveTeammateCompletion(agentId: string, fallbackStatus: AgentStatus, fallbackSummary?: string): {
		status: AgentStatus;
		summary?: string;
	} {
		return this.withRootLock(() => {
			for (const team of this.listTeams()) {
				const member = team.members.find((entry) => entry.agentId === agentId);
				if (!member) continue;
				if (member.status === "running") {
					return { status: fallbackStatus, summary: fallbackSummary };
				}
				return {
					status: member.status,
					summary: member.lastSummary ?? fallbackSummary,
				};
			}
			return { status: fallbackStatus, summary: fallbackSummary };
		});
	}

	shutdownTeam(teamName?: string, reason?: string): Team {
		return this.withRootLock(() => {
			const team = this.assertLeadControl(teamName);
			if (team.state === "shutdown") {
				this.rememberLeadTeamContext(team.name);
				return team;
			}
			team.state = "shutdown";
			team.shutdownAt = this.now();
			for (const member of team.members) {
				const live = this.options.registry.resolve(member.agentId);
				const unassigned = this.unassignTasksForMember(team.name, member);
				if (live?.status === "running") {
					this.options.registry.stopAgent(member.agentId);
					member.status = "stopped";
					member.pendingShutdownRequestId = undefined;
					member.lastSummary = member.lastSummary ?? reason;
					member.updatedAt = this.now();
					this.onMemberStopped?.(member, team, reason, unassigned);
					continue;
				}
				member.pendingShutdownRequestId = undefined;
				if (unassigned.unassignedTasks.length > 0) {
					member.lastSummary = member.lastSummary ?? reason;
					member.updatedAt = this.now();
				}
			}
			this.writeTeam(team);
			this.rememberLeadTeamContext(team.name);
			return team;
		});
	}

	private collectActiveNonLeadMembers(team: Team): TeamMember[] {
		return team.members.filter((member) => (this.resolveLiveTeammate(member)?.status ?? member.status) === "running");
	}

	private deletePersistedTeam(teamName: string): string[] {
		const configPath = this.getConfigPath(teamName);
		const tasksPath = this.getTasksPath(teamName);
		const teamDir = this.getTeamDir(teamName);
		const removedPaths = [configPath, tasksPath, teamDir].filter((entry, index, values) => values.indexOf(entry) === index && fs.existsSync(entry));
		fs.rmSync(configPath, { force: true });
		fs.rmSync(tasksPath, { force: true });
		fs.rmSync(teamDir, { recursive: true, force: true });
		return removedPaths;
	}

	deleteTeam(_reason?: string): DeleteTeamResult {
		return this.withRootLock(() => {
			if (this.isTeammateRuntime()) {
				throw new Error("Only the lead session may delete the current team.");
			}
			const sessionId = this.requireLeadSessionId();
			const team = this.resolveRememberedLeadTeam() ?? this.getActiveTeam();
			if (!team) {
				this.clearLeadTeamContext();
				clearLeaderTeamName(sessionId);
				return { noop: true, removedPaths: [], leadStateCleared: true };
			}
			const activeMembers = this.collectActiveNonLeadMembers(team);
			if (activeMembers.length > 0) {
				throw new Error(`Cannot delete team "${team.name}" while non-lead teammates are active: ${activeMembers.map((member) => member.name).join(", ")}`);
			}
			const removedPaths = this.deletePersistedTeam(team.name);
			this.clearLeadTeamContext(team.name);
			clearLeaderTeamName(sessionId);
			unregisterTeamForSessionCleanup(sessionId, team.name);
			return {
				teamName: team.name,
				noop: false,
				removedPaths,
				leadStateCleared: true,
			};
		});
	}

	cleanupSessionTeams(reason?: string): SessionCleanupResult {
		return this.withRootLock(() => {
			const sessionId = this.requireLeadSessionId();
			const teamNames = getSessionCreatedTeams(sessionId);
			if (teamNames.length === 0) {
				clearLeaderTeamName(sessionId);
				return { teamNames: [], cleanedTeams: [], failures: [] };
			}
			const cleanedTeams: string[] = [];
			const failures: SessionCleanupResult["failures"] = [];
			console.info(`[pi-teams] cleanupSessionTeams: removing ${teamNames.length} team(s): ${teamNames.join(", ")}`);
			for (const teamName of teamNames) {
				const team = this.safeReadTeamFile(this.getConfigPath(teamName));
				if (!team) {
					unregisterTeamForSessionCleanup(sessionId, teamName);
					continue;
				}
				for (const member of team.members) {
					const live = this.resolveLiveTeammate(member);
					if ((live?.status ?? member.status) !== "running") continue;
					try {
						this.options.registry.stopAgent(member.agentId);
						member.status = "stopped";
						member.pendingShutdownRequestId = undefined;
						member.lastSummary = member.lastSummary ?? reason;
						member.updatedAt = this.now();
						const unassigned = this.unassignTasksForMember(team.name, member);
						this.onMemberStopped?.(member, team, reason, unassigned);
					} catch (error) {
						failures.push({
							teamName,
							step: "stop",
							message: error instanceof Error ? error.message : String(error),
						});
					}
				}
				try {
					this.deletePersistedTeam(teamName);
					cleanedTeams.push(teamName);
					unregisterTeamForSessionCleanup(sessionId, teamName);
				} catch (error) {
					failures.push({
						teamName,
						step: "delete",
						message: error instanceof Error ? error.message : String(error),
					});
				}
			}
			this.clearLeadTeamContext();
			clearLeaderTeamName(sessionId);
			clearSessionCreatedTeams(sessionId);
			for (const failure of failures) {
				console.warn(`[pi-teams] cleanupSessionTeams ${failure.step} failed for ${failure.teamName}: ${failure.message}`);
			}
			return { teamNames, cleanedTeams, failures };
		});
	}

	shutdownActiveTeam(reason?: string): Team | undefined {
		const active = this.getActiveTeam();
		if (!active) return undefined;
		return this.shutdownTeam(active.name, reason);
	}
}
