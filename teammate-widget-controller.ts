export type WidgetUpdateKind = "state" | "progress";

interface CreateTeammateWidgetControllerOptions {
	progressThrottleMs: number;
	render: () => void;
	now?: () => number;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
}

export interface TeammateWidgetController {
	schedule(kind?: WidgetUpdateKind): void;
	clear(): void;
}

export interface SnapshotState {
	current: string | null;
}

export function applySnapshotIfChanged(
	nextSnapshot: string | null,
	state: SnapshotState,
	apply: (snapshot: string | null) => void,
): boolean {
	if (nextSnapshot === state.current) return false;
	state.current = nextSnapshot;
	apply(nextSnapshot);
	return true;
}

export function createTeammateWidgetController(
	options: CreateTeammateWidgetControllerOptions,
): TeammateWidgetController {
	const now = options.now ?? (() => Date.now());
	const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
	const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastRenderAt = 0;

	const flush = () => {
		options.render();
		lastRenderAt = now();
	};

	const clearTimer = () => {
		if (!timer) return;
		clearTimeoutFn(timer);
		timer = null;
	};

	return {
		schedule(kind = "state") {
			if (kind === "state") {
				clearTimer();
				flush();
				return;
			}
			const elapsed = now() - lastRenderAt;
			const delay = Math.max(0, options.progressThrottleMs - elapsed);
			if (delay === 0) {
				clearTimer();
				flush();
				return;
			}
			if (timer) return;
			timer = setTimeoutFn(() => {
				timer = null;
				flush();
			}, delay);
			timer.unref?.();
		},
		clear() {
			clearTimer();
			lastRenderAt = 0;
		},
	};
}
