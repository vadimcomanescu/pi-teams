export interface LifecycleDedupe {
	shouldProcess(key: string): boolean;
}

export function createLifecycleDedupe(ttlMs = 5_000): LifecycleDedupe {
	const seen = new Map<string, number>();

	return {
		shouldProcess(key: string): boolean {
			const now = Date.now();
			for (const [entryKey, expiresAt] of seen.entries()) {
				if (expiresAt <= now) {
					seen.delete(entryKey);
				}
			}
			const expiresAt = seen.get(key);
			if (expiresAt && expiresAt > now) {
				return false;
			}
			seen.set(key, now + ttlMs);
			return true;
		},
	};
}
