import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RegisteredAgent } from "./agent-registry.js";
import type { TeamParamsLike } from "./team-executor.js";
import type { TeamManager } from "./team-manager.js";
import type { Details } from "./types.js";

export type ResumeAgentFn = (
	agent: RegisteredAgent,
	message: string,
	signal: AbortSignal | undefined,
	ctx: unknown,
) => Promise<{ agentId: string }>;

interface ContinuationDeps {
	execute: (
		id: string,
		params: TeamParamsLike,
		signal: AbortSignal,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
	teamManager: TeamManager;
	getFallbackCwd: () => string;
}

export function createResumeAgent(deps: ContinuationDeps): ResumeAgentFn {
	return async (agent, message, signal, ctx) => {
		const callId = `resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const result = await deps.execute(callId, {
			agent: agent.agentType,
			task: message,
			name: agent.name,
			cwd: agent.cwd,
			model: agent.model,
			clarify: false,
			async: false,
			runtimeRole: agent.runtimeRole ?? "raw-worker",
			teamMetadata: agent.teamMetadata,
			sessionFile: agent.sessionFile,
		}, signal ?? new AbortController().signal, undefined, ctx as ExtensionContext);
		if (result.isError || !result.details?.asyncId) {
			throw new Error(result.content.map((item) => item.type === "text" ? item.text : "").join("\n") || "Failed to resume teammate");
		}
		if (agent.runtimeRole === "teammate" && agent.teamMetadata?.teamName && agent.name) {
			deps.teamManager.registerTeammate(agent.teamMetadata.teamName, {
				name: agent.name,
				agentId: result.details.asyncId,
				agentType: agent.agentType,
				model: agent.model,
				status: "running",
				cwd: agent.cwd ?? deps.getFallbackCwd(),
			});
		}
		return { agentId: result.details.asyncId };
	};
}
