const leaderTeamNamesBySession = new Map<string, string>();

export function setLeaderTeamName(sessionId: string, teamName: string): void {
	leaderTeamNamesBySession.set(sessionId, teamName);
}

export function getLeaderTeamName(sessionId: string | null | undefined): string | undefined {
	if (!sessionId) return undefined;
	return leaderTeamNamesBySession.get(sessionId);
}

export function clearLeaderTeamName(sessionId?: string | null): void {
	if (sessionId) {
		leaderTeamNamesBySession.delete(sessionId);
		return;
	}
	leaderTeamNamesBySession.clear();
}
