import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentRegistry, AgentStatus } from "./agent-registry.js";
import { withFileLock, writeJsonAtomically } from "./state-file-utils.js";

export type TeamState = "active" | "shutdown" | "orphaned";

export interface TeamMember {
	name: string;
	agentId: string;
	agentType: string;
	model?: string;
	status: AgentStatus;
	cwd: string;
	lastSummary?: string;
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

interface TeamManagerOptions {
	registry: AgentRegistry;
	getCurrentSessionId: () => string | null;
	rootDir?: string;
	now?: () => number;
	onMemberStopped?: (member: TeamMember, team: Team, reason?: string) => void;
}

export class TeamConfigError extends Error {}

function sanitizeTeamName(teamName: string): string {
	return teamName.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export class TeamManager {
	private readonly options: TeamManagerOptions;
	private readonly rootDir: string;
	private readonly now: () => number;
	private readonly onMemberStopped?: TeamManagerOptions["onMemberStopped"];
	private readonly rootLockPath: string;

	constructor(options: TeamManagerOptions) {
		this.options = options;
		this.rootDir = options.rootDir ?? path.join(os.homedir(), ".pi", "teams");
		this.now = options.now ?? (() => Date.now());
		this.onMemberStopped = options.onMemberStopped;
		this.rootLockPath = path.join(this.rootDir, ".teams-root");
		fs.mkdirSync(this.rootDir, { recursive: true });
	}

	getRootDir(): string {
		return this.rootDir;
	}

	getTeamDir(teamName: string): string {
		return path.join(this.rootDir, sanitizeTeamName(teamName));
	}

	getConfigPath(teamName: string): string {
		return path.join(this.getTeamDir(teamName), "config.json");
	}

	getTasksPath(teamName: string): string {
		return path.join(this.getTeamDir(teamName), "tasks.json");
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

	private requireLeadSessionId(): string {
		const sessionId = this.options.getCurrentSessionId();
		if (!sessionId) {
			throw new Error("Team operations require an active lead session.");
		}
		return sessionId;
	}

	assertLeadControl(teamName: string): Team {
		const team = this.getTeam(teamName);
		if (!team) {
			throw new Error(`Team not found: ${teamName}`);
		}
		const sessionId = this.requireLeadSessionId();
		if (team.leadSessionId !== sessionId) {
			throw new Error(`Only the lead session may mutate team "${teamName}".`);
		}
		return team;
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
		});
	}

	createTeam(input: { team_name: string; description?: string; default_model?: string }): Team {
		return this.withRootLock(() => {
			const sessionId = this.requireLeadSessionId();
			const teamName = input.team_name.trim();
			if (!teamName) {
				throw new Error("team_name is required");
			}
			const activeTeam = this.getActiveTeam();
			if (activeTeam) {
				throw new Error(`Only one active team is allowed per lead session. Active team: ${activeTeam.name}`);
			}
			if (this.teamDirExists(teamName)) {
				throw new Error(`Team name already exists on disk and cannot be reused in this pass: ${teamName}`);
			}
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
			return team;
		});
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
			if (team.members.some((existing) => existing.name.toLowerCase() === member.name.toLowerCase() && existing.status === "running")) {
				throw new Error(`Teammate name already active in team "${teamName}": ${member.name}`);
			}
			const persisted: TeamMember = {
				...member,
				updatedAt: this.now(),
			};
			team.members.push(persisted);
			this.writeTeam(team);
			return persisted;
		});
	}

	checkTeammate(teamName: string, agentName: string): {
		teamName: string;
		effectiveModel?: string;
		status: AgentStatus;
		lastSummary?: string;
		member: TeamMember;
		state: TeamState;
	} {
		const team = this.getTeam(teamName);
		if (!team) {
			throw new Error(`Team not found: ${teamName}`);
		}
		const member = team.members.find((entry) => entry.name.toLowerCase() === agentName.toLowerCase());
		if (!member) {
			throw new Error(`Teammate not found in team "${teamName}": ${agentName}`);
		}
		const live = this.options.registry.resolve(member.agentId);
		return {
			teamName: team.name,
			effectiveModel: member.model ?? team.defaultModel,
			status: live?.status ?? member.status,
			lastSummary: live?.result ?? member.lastSummary,
			member: live ? { ...member, status: live.status } : member,
			state: team.state,
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
				if (lastSummary !== undefined) {
					member.lastSummary = lastSummary;
				}
				this.writeTeam(team);
				return;
			}
		});
	}

	shutdownTeam(teamName: string, reason?: string): Team {
		return this.withRootLock(() => {
			const team = this.assertLeadControl(teamName);
			if (team.state === "shutdown") {
				return team;
			}
			team.state = "shutdown";
			team.shutdownAt = this.now();
			for (const member of team.members) {
				const live = this.options.registry.resolve(member.agentId);
				if (live?.status === "running") {
					this.options.registry.stopAgent(member.agentId);
					member.status = "stopped";
					member.lastSummary = member.lastSummary ?? reason;
					member.updatedAt = this.now();
					this.onMemberStopped?.(member, team, reason);
				}
			}
			this.writeTeam(team);
			return team;
		});
	}

	shutdownActiveTeam(reason?: string): Team | undefined {
		const active = this.getActiveTeam();
		if (!active) return undefined;
		return this.shutdownTeam(active.name, reason);
	}
}
