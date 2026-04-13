export interface LeadSessionRuntimeDeps {
	bootstrapTeamManager(): void;
	runStartupOrphanCleanup(): void;
	startTeamInboxPoller(): void;
	scheduleTeammateWidgetRender(kind: "state"): void;
	startTimeoutSweeper(): void;
}

export function startLeadSessionRuntime(deps: LeadSessionRuntimeDeps): void {
	deps.bootstrapTeamManager();
	deps.runStartupOrphanCleanup();
	deps.startTeamInboxPoller();
	deps.scheduleTeammateWidgetRender("state");
	deps.startTimeoutSweeper();
}
