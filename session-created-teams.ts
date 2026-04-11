const sessionCreatedTeamsBySession = new Map<string, Set<string>>();

export function registerTeamForSessionCleanup(sessionId: string, teamName: string): void {
	let teams = sessionCreatedTeamsBySession.get(sessionId);
	if (!teams) {
		teams = new Set<string>();
		sessionCreatedTeamsBySession.set(sessionId, teams);
	}
	teams.add(teamName);
}

export function unregisterTeamForSessionCleanup(sessionId: string | null | undefined, teamName: string): void {
	if (!sessionId) return;
	const teams = sessionCreatedTeamsBySession.get(sessionId);
	if (!teams) return;
	teams.delete(teamName);
	if (teams.size === 0) {
		sessionCreatedTeamsBySession.delete(sessionId);
	}
}

export function getSessionCreatedTeams(sessionId: string | null | undefined): string[] {
	if (!sessionId) return [];
	return Array.from(sessionCreatedTeamsBySession.get(sessionId) ?? []);
}

export function clearSessionCreatedTeams(sessionId?: string | null): void {
	if (sessionId) {
		sessionCreatedTeamsBySession.delete(sessionId);
		return;
	}
	sessionCreatedTeamsBySession.clear();
}
