/**
 * Coordinator mode state, settings, and helpers.
 *
 * When coordinator mode is active the main LLM orchestrates worker agents
 * instead of coding directly.  Tools like send_message and task_stop are
 * only registered in this mode.
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

export function isCoordinatorMode(): boolean {
	return coordinatorActive;
}

export function setCoordinatorMode(active: boolean): void {
	coordinatorActive = active;
}
