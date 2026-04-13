import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySnapshotIfChanged, createTeammateWidgetController } from "./teammate-widget-controller.ts";

class FakeClock {
	nowMs = 0;
	private nextId = 1;
	private timers: Array<{ id: number; at: number; fn: () => void; canceled: boolean; unref: () => void }> = [];

	now = () => this.nowMs;

	setTimeout = (fn: () => void, delay: number) => {
		const timer = {
			id: this.nextId++,
			at: this.nowMs + Math.max(0, delay),
			fn,
			canceled: false,
			unref: () => {},
		};
		this.timers.push(timer);
		return timer as unknown as ReturnType<typeof setTimeout>;
	};

	clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
		const match = this.timers.find((entry) => entry.id === (timer as unknown as { id: number }).id);
		if (match) match.canceled = true;
	};

	advance(ms: number): void {
		const target = this.nowMs + ms;
		while (true) {
			let next: (typeof this.timers)[number] | undefined;
			for (const timer of this.timers) {
				if (timer.canceled) continue;
				if (timer.at > target) continue;
				if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) {
					next = timer;
				}
			}
			if (!next) break;
			this.nowMs = next.at;
			next.canceled = true;
			next.fn();
		}
		this.nowMs = target;
	}
}

describe("teammate widget controller", () => {
	it("renders state updates immediately", () => {
		const clock = new FakeClock();
		const renders: number[] = [];
		const controller = createTeammateWidgetController({
			progressThrottleMs: 3000,
			render: () => renders.push(clock.now()),
			now: clock.now,
			setTimeoutFn: clock.setTimeout as unknown as typeof setTimeout,
			clearTimeoutFn: clock.clearTimeout as unknown as typeof clearTimeout,
		});

		controller.schedule("state");
		assert.deepEqual(renders, [0]);
	});

	it("coalesces progress updates and flushes once per throttle window", () => {
		const clock = new FakeClock();
		const renders: number[] = [];
		const controller = createTeammateWidgetController({
			progressThrottleMs: 3000,
			render: () => renders.push(clock.now()),
			now: clock.now,
			setTimeoutFn: clock.setTimeout as unknown as typeof setTimeout,
			clearTimeoutFn: clock.clearTimeout as unknown as typeof clearTimeout,
		});

		controller.schedule("state");
		controller.schedule("progress");
		clock.advance(500);
		controller.schedule("progress");
		clock.advance(2499);
		assert.deepEqual(renders, [0]);
		clock.advance(1);
		assert.deepEqual(renders, [0, 3000]);
	});

	it("renders progress immediately when throttle interval has elapsed", () => {
		const clock = new FakeClock();
		const renders: number[] = [];
		const controller = createTeammateWidgetController({
			progressThrottleMs: 3000,
			render: () => renders.push(clock.now()),
			now: clock.now,
			setTimeoutFn: clock.setTimeout as unknown as typeof setTimeout,
			clearTimeoutFn: clock.clearTimeout as unknown as typeof clearTimeout,
		});

		controller.schedule("state");
		clock.advance(3000);
		controller.schedule("progress");
		assert.deepEqual(renders, [0, 3000]);
	});

	it("does not re-apply identical snapshots", () => {
		const state = { current: null as string | null };
		const applied: Array<string | null> = [];
		assert.equal(applySnapshotIfChanged("A", state, (snapshot) => applied.push(snapshot)), true);
		assert.equal(applySnapshotIfChanged("A", state, (snapshot) => applied.push(snapshot)), false);
		assert.equal(applySnapshotIfChanged("B", state, (snapshot) => applied.push(snapshot)), true);
		assert.equal(applySnapshotIfChanged(null, state, (snapshot) => applied.push(snapshot)), true);
		assert.equal(applySnapshotIfChanged(null, state, (snapshot) => applied.push(snapshot)), false);
		assert.deepEqual(applied, ["A", "B", null]);
	});
});
