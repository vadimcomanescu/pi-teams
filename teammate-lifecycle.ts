import type { AgentStatus } from "./agent-registry.js";

export interface TeammateLifecycleInput {
	status: AgentStatus;
	sessionFile?: string;
	acceptsFollowUps?: boolean;
	active?: boolean;
}

export interface TeammateLifecycle {
	activity: "running" | "idle";
	addressable: boolean;
	canQueueFollowUp: boolean;
	canResume: boolean;
	continuationText: string;
}

export function describeTeammateLifecycle(input: TeammateLifecycleInput): TeammateLifecycle {
	const active = input.active ?? true;
	const acceptsFollowUps = input.acceptsFollowUps === true;
	const hasSession = Boolean(input.sessionFile);
	const activity = input.status === "running" ? "running" : "idle";
	const canQueueFollowUp = input.status === "running" && acceptsFollowUps && active;
	const canResume = input.status !== "running" && hasSession && active;
	const addressable = canQueueFollowUp || canResume;

	if (!active) {
		return {
			activity,
			addressable,
			canQueueFollowUp,
			canResume,
			continuationText: "this team is not active, create or resume work in an active team first",
		};
	}

	if (canQueueFollowUp) {
		return {
			activity,
			addressable,
			canQueueFollowUp,
			canResume,
			continuationText: "send_message will queue a follow-up immediately",
		};
	}

	if (input.status === "running") {
		return {
			activity,
			addressable,
			canQueueFollowUp,
			canResume,
			continuationText: "this worker is running in background mode and does not accept follow-up messages",
		};
	}

	if (canResume) {
		return {
			activity,
			addressable,
			canQueueFollowUp,
			canResume,
			continuationText: "send_message can resume this teammate",
		};
	}

	return {
		activity,
		addressable,
		canQueueFollowUp,
		canResume,
		continuationText: "spawn a fresh teammate if you need to continue this line of work",
	};
}
