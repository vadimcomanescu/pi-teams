/**
 * Coordinator mode state, settings, runtime roles, and helpers.
 */

// =============================================================================
// Settings
// =============================================================================

export interface CoordinatorSettings {
	/** Maximum concurrent worker agents (default: 8) */
	maxConcurrentWorkers: number;
	/** Worker timeout in milliseconds (default: 300 000 — 5 min) */
	workerTimeoutMs: number;
}

const DEFAULT_COORDINATOR_SETTINGS: CoordinatorSettings = {
	maxConcurrentWorkers: 8,
	workerTimeoutMs: 300_000,
};

let settings: CoordinatorSettings = { ...DEFAULT_COORDINATOR_SETTINGS };

export function getCoordinatorSettings(): Readonly<CoordinatorSettings> {
	return settings;
}

export function updateCoordinatorSettings(
	overrides: Partial<CoordinatorSettings>,
): void {
	settings = { ...settings, ...overrides };
}

// =============================================================================
// Mode Flag
// =============================================================================

let coordinatorActive = false;

export type RuntimeRole = "lead" | "teammate" | "raw-worker";

export interface TeammateRuntimeMetadata {
	teamName: string;
	teammateNames: string[];
	assignedTaskIds: string[];
	configPath: string;
	tasksPath: string;
}

const RUNTIME_ROLE_ENV = "PI_TEAMS_RUNTIME_ROLE";
const TEAM_NAME_ENV = "PI_TEAMS_TEAM_NAME";
const TEAMMATE_NAMES_ENV = "PI_TEAMS_TEAMMATE_NAMES_JSON";
const ASSIGNED_TASK_IDS_ENV = "PI_TEAMS_ASSIGNED_TASK_IDS_JSON";
const TEAM_CONFIG_PATH_ENV = "PI_TEAMS_TEAM_CONFIG_PATH";
const TEAM_TASKS_PATH_ENV = "PI_TEAMS_TEAM_TASKS_PATH";

export function getRuntimeRole(): RuntimeRole {
	const value = process.env[RUNTIME_ROLE_ENV];
	if (value === "teammate" || value === "raw-worker") {
		return value;
	}
	return "lead";
}

export function isLeadRuntimeRole(): boolean {
	return getRuntimeRole() === "lead";
}

export function buildRuntimeEnv(
	role: Exclude<RuntimeRole, "lead">,
	metadata?: TeammateRuntimeMetadata,
): Record<string, string> {
	const env: Record<string, string> = {
		[RUNTIME_ROLE_ENV]: role,
	};
	if (role === "teammate" && metadata) {
		env[TEAM_NAME_ENV] = metadata.teamName;
		env[TEAMMATE_NAMES_ENV] = JSON.stringify(metadata.teammateNames);
		env[ASSIGNED_TASK_IDS_ENV] = JSON.stringify(metadata.assignedTaskIds);
		env[TEAM_CONFIG_PATH_ENV] = metadata.configPath;
		env[TEAM_TASKS_PATH_ENV] = metadata.tasksPath;
	}
	return env;
}

export function getTeammateRuntimeMetadata(): TeammateRuntimeMetadata | null {
	if (getRuntimeRole() !== "teammate") return null;
	const teamName = process.env[TEAM_NAME_ENV];
	const configPath = process.env[TEAM_CONFIG_PATH_ENV];
	const tasksPath = process.env[TEAM_TASKS_PATH_ENV];
	if (!teamName || !configPath || !tasksPath) return null;
	const parseJsonArray = (value: string | undefined): string[] => {
		if (!value) return [];
		try {
			const parsed = JSON.parse(value) as unknown;
			return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
		} catch {
			return [];
		}
	};
	return {
		teamName,
		teammateNames: parseJsonArray(process.env[TEAMMATE_NAMES_ENV]),
		assignedTaskIds: parseJsonArray(process.env[ASSIGNED_TASK_IDS_ENV]),
		configPath,
		tasksPath,
	};
}

export function getCurrentTeammateTeamName(): string | null {
	return getTeammateRuntimeMetadata()?.teamName ?? null;
}

export function getTeammateSystemPromptBlock(): string | null {
	const metadata = getTeammateRuntimeMetadata();
	if (!metadata) return null;
	const teammateNames = metadata.teammateNames.length > 0 ? metadata.teammateNames.join(", ") : "(none yet)";
	const taskIds = metadata.assignedTaskIds.length > 0 ? metadata.assignedTaskIds.join(", ") : "(none assigned yet)";
	return [
		`You are a teammate in team "${metadata.teamName}".`,
		`Other teammates: ${teammateNames}.`,
		"The lead manages the team and may send you follow-up messages.",
		`Assigned task ids: ${taskIds}.`,
		`Team config path: ${metadata.configPath}.`,
		`Tasks file path: ${metadata.tasksPath}.`,
		"Read task state to understand assigned work.",
		"Do not mutate team lifecycle or task state unless explicitly allowed.",
		"When you finish, report clearly so the lead can synthesize and update tasks.",
	].join("\n");
}

export function isCoordinatorMode(): boolean {
	return coordinatorActive;
}

export function setCoordinatorMode(active: boolean): void {
	coordinatorActive = active;
}
