/**
 * Agent Process Registry
 *
 * Tracks running/completed agents by name and ID so SendMessage can route
 * messages and TaskStop can kill processes. Handles worker lifecycle
 * (timeouts, cleanup on shutdown).
 */

import type { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";

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
}

export type AgentStatus = RegisteredAgent["status"];

// =============================================================================
// Registry
// =============================================================================

export class AgentRegistry {
	private agents = new Map<string, RegisteredAgent>();
	private nameIndex = new Map<string, string>(); // lowercase name → id
	private timeoutSweepInterval: ReturnType<typeof setInterval> | null = null;
	private onTimeout?: (agent: RegisteredAgent) => void;

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

	/**
	 * Update the status of a registered agent.
	 */
	updateStatus(id: string, status: AgentStatus, result?: string): void {
		const agent = this.agents.get(id);
		if (!agent) return;
		agent.status = status;
		if (result !== undefined) {
			agent.result = result;
		}
		if (status !== "running") {
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

	/**
	 * Stop a single agent by ID. Sends abort to RPC agents, SIGTERM to others.
	 */
	stopAgent(id: string): void {
		const agent = this.agents.get(id);
		if (!agent || agent.status !== "running") return;

		if (agent.rpcHandle) {
			// RPC agent: send abort command first
			try {
				agent.rpcHandle.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
			} catch {
				// stdin may already be closed
			}
			// Give 2s for graceful shutdown, then SIGTERM
			const proc = agent.rpcHandle.proc;
			setTimeout(() => {
				if (!proc.killed) {
					proc.kill("SIGTERM");
				}
			}, 2000);
		} else if (agent.pid) {
			try {
				process.kill(agent.pid, "SIGTERM");
			} catch {
				// Process may have already exited
			}
		}

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
				if (now - agent.startTime > timeoutMs) {
					this.stopAgent(agent.id);
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
