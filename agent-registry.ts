/**
 * Agent Process Registry
 *
 * Tracks running/completed agents by name and ID so SendMessage can route
 * messages and TaskStop can kill processes. Handles worker lifecycle
 * (timeouts, cleanup on shutdown).
 */

import type { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { RuntimeRole, TeammateRuntimeMetadata } from "./coordinator.js";

// =============================================================================
// Types
// =============================================================================

export interface RpcHandle {
	stdin: Writable;
	proc: ChildProcess;
}

export interface RegisteredAgent {
	id: string;
	name?: string;
	agentType: string;
	task: string;
	pid?: number;
	status: "running" | "completed" | "failed" | "stopped" | "timed_out";
	startTime: number;
	endTime?: number;
	rpcHandle?: RpcHandle;
	result?: string;
	sessionFile?: string;
	asyncDir?: string;
	cwd?: string;
	model?: string;
	runtimeRole?: RuntimeRole;
	teamMetadata?: TeammateRuntimeMetadata;
	currentTool?: string;
	recentOutput?: string[];
	toolCount?: number;
	tokens?: number;
	durationMs?: number;
	lastUpdateAt?: number;
}

export type AgentStatus = RegisteredAgent["status"];

// =============================================================================
// Registry
// =============================================================================

interface AgentRegistryOptions {
	abortGraceMs?: number;
	forceKillGraceMs?: number;
	setTimeoutFn?: typeof setTimeout;
}

export class AgentRegistry {
	private agents = new Map<string, RegisteredAgent>();
	private nameIndex = new Map<string, string>(); // lowercase name → id
	private timeoutSweepInterval: ReturnType<typeof setInterval> | null = null;
	private onTimeout?: (agent: RegisteredAgent) => void;
	private readonly abortGraceMs: number;
	private readonly forceKillGraceMs: number;
	private readonly setTimeoutFn: typeof setTimeout;

	constructor(options: AgentRegistryOptions = {}) {
		this.abortGraceMs = options.abortGraceMs ?? 2000;
		this.forceKillGraceMs = options.forceKillGraceMs ?? 3000;
		this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
	}

	/**
	 * Register a new agent. Throws if a name is already taken by a running agent.
	 */
	register(agent: RegisteredAgent): void {
		if (this.agents.has(agent.id)) {
			throw new Error(`Agent with id "${agent.id}" is already registered`);
		}
		if (agent.name) {
			const key = agent.name.toLowerCase();
			const existingId = this.nameIndex.get(key);
			if (existingId) {
				const existing = this.agents.get(existingId);
				if (existing && existing.status === "running") {
					throw new Error(
						`Agent name "${agent.name}" is already in use by running agent "${existingId}"`,
					);
				}
				// Name was used by a non-running agent — allow reuse, clean up old mapping
				this.nameIndex.delete(key);
			}
			this.nameIndex.set(key, agent.id);
		}
		this.agents.set(agent.id, agent);
	}

	/**
	 * Resolve an agent by name (case-insensitive) or ID.
	 */
	resolve(nameOrId: string): RegisteredAgent | undefined {
		// Try name index first (case-insensitive)
		const idFromName = this.nameIndex.get(nameOrId.toLowerCase());
		if (idFromName) {
			return this.agents.get(idFromName);
		}
		// Fall back to direct ID lookup
		return this.agents.get(nameOrId);
	}

	private shouldIgnoreStatusUpdate(current: AgentStatus, next: AgentStatus): boolean {
		if (current === next) return false;
		if (current === "running") return false;
		return true;
	}

	/**
	 * Update the status of a registered agent.
	 *
	 * Once an agent reaches a terminal state, later duplicate process-exit events
	 * must not regress it to a different terminal state. This prevents stop/timeout
	 * decisions from being overwritten by late completion/failure races.
	 */
	updateStatus(id: string, status: AgentStatus, result?: string): void {
		const agent = this.agents.get(id);
		if (!agent) return;
		if (this.shouldIgnoreStatusUpdate(agent.status, status)) {
			if (agent.result === undefined && result !== undefined) {
				agent.result = result;
			}
			return;
		}
		agent.status = status;
		if (result !== undefined) {
			agent.result = result;
		}
		if (status !== "running" && agent.endTime === undefined) {
			agent.endTime = Date.now();
		}
	}

	/**
	 * Get all currently running agents.
	 */
	getRunning(): RegisteredAgent[] {
		return [...this.agents.values()].filter((a) => a.status === "running");
	}

	/**
	 * Get all registered agents regardless of status.
	 */
	getAll(): RegisteredAgent[] {
		return [...this.agents.values()];
	}

	/**
	 * Get all known agent names (for error messages).
	 */
	getNames(): string[] {
		return [...this.agents.values()]
			.filter((a) => a.name)
			.map((a) => `${a.name} (${a.status})`);
	}

	patch(id: string, changes: Partial<Omit<RegisteredAgent, "id">>): void {
		const agent = this.agents.get(id);
		if (!agent) return;
		Object.assign(agent, changes);
	}

	/**
	 * Remove an agent from the registry entirely.
	 */
	remove(id: string): void {
		const agent = this.agents.get(id);
		if (!agent) return;
		if (agent.name) {
			const key = agent.name.toLowerCase();
			if (this.nameIndex.get(key) === id) {
				this.nameIndex.delete(key);
			}
		}
		this.agents.delete(id);
	}

	private isProcessAlive(proc: ChildProcess): boolean {
		return !proc.killed && proc.exitCode === null && proc.signalCode === null;
	}

	private scheduleKillEscalation(proc: ChildProcess): void {
		this.setTimeoutFn(() => {
			if (this.isProcessAlive(proc)) {
				proc.kill("SIGTERM");
			}
			this.setTimeoutFn(() => {
				if (this.isProcessAlive(proc)) {
					proc.kill("SIGKILL");
				}
			}, this.forceKillGraceMs);
		}, this.abortGraceMs);
	}

	/**
	 * Send kill signals to a running agent. Does NOT update status —
	 * the caller decides the final status (stopped, timed_out, etc.).
	 */
	killAgent(id: string): void {
		const agent = this.agents.get(id);
		if (!agent || agent.status !== "running") return;

		if (agent.rpcHandle) {
			const proc = agent.rpcHandle.proc;
			// RPC agent: send abort command first
			try {
				agent.rpcHandle.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
			} catch {
				// stdin already closed — escalate immediately
				if (this.isProcessAlive(proc)) {
					proc.kill("SIGTERM");
				}
				this.setTimeoutFn(() => {
					if (this.isProcessAlive(proc)) {
						proc.kill("SIGKILL");
					}
				}, this.forceKillGraceMs);
				return;
			}
			this.scheduleKillEscalation(proc);
		} else if (agent.pid) {
			try {
				process.kill(agent.pid, "SIGTERM");
			} catch {
				// Process may have already exited
			}
			this.setTimeoutFn(() => {
				try {
					process.kill(agent.pid!, "SIGKILL");
				} catch {
					// Process already exited
				}
			}, this.forceKillGraceMs);
		}
	}

	/**
	 * Stop a single agent: kill + update status.
	 */
	stopAgent(id: string): void {
		this.killAgent(id);
		this.updateStatus(id, "stopped");
	}

	/**
	 * SIGTERM all running agents. Called on shutdown.
	 */
	stopAll(): void {
		for (const agent of this.getRunning()) {
			this.stopAgent(agent.id);
		}
	}

	/**
	 * Start a periodic sweeper that stops workers exceeding the timeout.
	 */
	startTimeoutSweeper(
		timeoutMs: number,
		intervalMs = 30_000,
		onTimeout?: (agent: RegisteredAgent) => void,
	): void {
		this.onTimeout = onTimeout;
		this.stopTimeoutSweeper();
		this.timeoutSweepInterval = setInterval(() => {
			const now = Date.now();
			for (const agent of this.getRunning()) {
				const lastActivityAt = agent.lastUpdateAt ?? agent.startTime;
				if (now - lastActivityAt > timeoutMs) {
					this.killAgent(agent.id);
					this.updateStatus(agent.id, "timed_out");
					this.onTimeout?.(agent);
				}
			}
		}, intervalMs);
		// Don't keep the process alive just for the sweeper
		this.timeoutSweepInterval.unref();
	}

	/**
	 * Stop the timeout sweeper interval.
	 */
	stopTimeoutSweeper(): void {
		if (this.timeoutSweepInterval) {
			clearInterval(this.timeoutSweepInterval);
			this.timeoutSweepInterval = null;
		}
	}

	/**
	 * Full cleanup: stop all agents and the sweeper.
	 */
	dispose(): void {
		this.stopAll();
		this.stopTimeoutSweeper();
	}
}
