import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTeammateSpinnerLines } from "./teammate-spinner-line.ts";

describe("buildTeammateSpinnerLines", () => {
	it("should render claude-style leader and teammate lines", () => {
		const lines = buildTeammateSpinnerLines([
			{
				name: "docs",
				status: "running",
				activity: "running",
				task: "Update README",
				currentTool: "edit README.md",
				recentOutput: ["Patched README section"],
			},
		], { nowMs: 10_000, frame: 0 });

		assert.equal(lines[0], "  ┌─ Lead");
		assert.match(lines[1], /^  └─ @docs: [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Patched README section…$/);
	});

	it("should include idle elapsed text", () => {
		const lines = buildTeammateSpinnerLines([
			{
				name: "arch",
				status: "running",
				activity: "idle",
				idleSinceMs: 4_000,
			},
		], { nowMs: 10_000, frame: 2 });

		assert.equal(lines[0], "  ┌─ Lead");
		assert.equal(lines[1], "  └─ @arch: Idle for 5s");
	});

	it("should show user-facing approval state without raw brackets", () => {
		const lines = buildTeammateSpinnerLines([
			{
				name: "qa",
				status: "running",
				activity: "running",
				pendingApproval: true,
				task: "Finalize tests",
			},
		], { nowMs: 10_000, frame: 1 });

		assert.equal(lines[1], "  └─ @qa: Awaiting approval");
		assert.doesNotMatch(lines[1], /^.*\[[^\]]+\].*$/);
	});

	it("should animate active running teammates across frames", () => {
		const members = [{
			name: "spec",
			status: "running" as const,
			activity: "running" as const,
			task: "Audit plan parity",
		}];
		const first = buildTeammateSpinnerLines(members, { nowMs: 10_000, frame: 0 });
		const second = buildTeammateSpinnerLines(members, { nowMs: 10_200, frame: 7 });
		assert.notDeepEqual(second, first);
		assert.match(first[1], /^  └─ @spec: [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Audit plan parity…$/);
		assert.match(second[1], /^  └─ @spec: [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Audit plan parity…$/);
	});

	it("should render tree indentation for multiple teammates", () => {
		const lines = buildTeammateSpinnerLines([
			{ name: "a", status: "running", activity: "running", task: "One" },
			{ name: "b", status: "running", activity: "idle", task: "Two" },
		], { nowMs: 10_000, frame: 0 });

		assert.match(lines[1], /^  ├─ @a: [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] One…$/);
		assert.equal(lines[2], "  └─ @b: Idle");
	});

	it("should filter low-signal output noise before choosing activity text", () => {
		const lines = buildTeammateSpinnerLines([
			{
				name: "docs",
				status: "running",
				activity: "running",
				recentOutput: ["```json", "{", "}", ""],
				currentTool: "read README.md",
				task: "Polish docs",
			},
		], { nowMs: 10_000, frame: 0 });

		assert.match(lines[1], /^  └─ @docs: [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] read README\.md…$/);
	});

	it("should use user-facing terminal status labels", () => {
		const failed = buildTeammateSpinnerLines([
			{ name: "qa", status: "failed", activity: "idle" },
		], { nowMs: 10_000, frame: 0 });
		const timedOut = buildTeammateSpinnerLines([
			{ name: "qa", status: "timed_out", activity: "idle" },
		], { nowMs: 10_000, frame: 0 });
		const stopped = buildTeammateSpinnerLines([
			{ name: "qa", status: "stopped", activity: "idle" },
		], { nowMs: 10_000, frame: 0 });

		assert.equal(failed[1], "  └─ @qa: Failed");
		assert.equal(timedOut[1], "  └─ @qa: Timed out");
		assert.equal(stopped[1], "  └─ @qa: Stopped");
	});

	it("should keep same activity text when only frame changes and output is unchanged", () => {
		const baseMember = {
			name: "qa",
			status: "running" as const,
			activity: "running" as const,
			task: "Run regression suite",
		};
		const first = buildTeammateSpinnerLines([{ ...baseMember, recentOutput: ["Running tests"] }], { nowMs: 10_000, frame: 0 });
		const same = buildTeammateSpinnerLines([{ ...baseMember, recentOutput: ["Running tests"] }], { nowMs: 20_000, frame: 3 });
		const changed = buildTeammateSpinnerLines([{ ...baseMember, recentOutput: ["Captured failure in send_message"] }], { nowMs: 20_000, frame: 3 });
		assert.match(first[1], /Running tests/);
		assert.match(same[1], /Running tests/);
		assert.match(changed[1], /Captured failure in send_message/);
	});

	it("should show selection highlight without interaction hints", () => {
		const lines = buildTeammateSpinnerLines([
			{
				name: "impl",
				status: "running",
				activity: "running",
				task: "Implement PR11",
				toolCount: 3,
				tokens: 1520,
			},
		], {
			nowMs: 10_000,
			frame: 0,
			selectionMode: true,
			selectedIndex: 0,
		});

		assert.equal(lines[0], "  ┌─ Lead");
		assert.match(lines[1], /^› ╘═ @impl: • Implement PR11… · 3 tool uses · 1,520 tokens$/);
	});

	it("should stay within narrow terminal width and drop stats first", () => {
		const lines = buildTeammateSpinnerLines([
			{
				name: "implementation-reviewer",
				status: "running",
				activity: "running",
				recentOutput: ["Patched live activity selection and restarted timeout sweeper"],
				toolCount: 12,
				tokens: 12034,
			},
		], {
			nowMs: 10_000,
			frame: 0,
			columns: 44,
		});

		assert.ok(lines.every((line) => line.length <= 44), `all lines should fit 44 columns: ${lines.join(" | ")}`);
		assert.match(lines[1], /Patched live activit…/);
		assert.doesNotMatch(lines[1], /tool uses|tokens/);
		assert.match(lines[1], /@implem…viewer/);
	});

	it("should keep stats on wide terminals when space allows", () => {
		const lines = buildTeammateSpinnerLines([
			{
				name: "implementation-reviewer",
				status: "running",
				activity: "running",
				task: "Verify parity smoke",
				toolCount: 3,
				tokens: 1520,
			},
		], {
			nowMs: 10_000,
			frame: 0,
			columns: 96,
		});

		assert.match(lines[1], /Verify parity smoke… · 3 tool uses · 1,520 tokens$/);
	});
});
