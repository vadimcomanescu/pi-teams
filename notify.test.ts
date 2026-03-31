import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { buildCoordinatorXml, buildMarkdownNotification } from "./notify-format.ts";
import { setCoordinatorMode, isCoordinatorMode } from "./coordinator.ts";

describe("buildCoordinatorXml", () => {
	it("produces valid XML with all fields", () => {
		const xml = buildCoordinatorXml({
			id: "agent-abc",
			agent: "worker",
			name: "researcher",
			success: true,
			summary: "Found the bug at validate.ts:42",
			exitCode: 0,
			timestamp: Date.now(),
			usage: { totalTokens: 15420, toolUses: 8, durationMs: 34200 },
		});

		assert.ok(xml.includes("<task-notification>"));
		assert.ok(xml.includes("</task-notification>"));
		assert.ok(xml.includes("<task-id>agent-abc</task-id>"));
		assert.ok(xml.includes("<task-name>researcher</task-name>"));
		assert.ok(xml.includes("<status>completed</status>"));
		assert.ok(xml.includes('<summary>Agent "researcher" completed</summary>'));
		assert.ok(xml.includes("<result>Found the bug at validate.ts:42</result>"));
		assert.ok(xml.includes("<total_tokens>15420</total_tokens>"));
		assert.ok(xml.includes("<tool_uses>8</tool_uses>"));
		assert.ok(xml.includes("<duration_ms>34200</duration_ms>"));
	});

	it("omits optional fields when missing", () => {
		const xml = buildCoordinatorXml({
			id: "agent-xyz",
			agent: "worker",
			success: false,
			summary: "Build failed",
			exitCode: 1,
			timestamp: Date.now(),
		});

		assert.ok(xml.includes("<task-notification>"));
		assert.ok(xml.includes("<task-id>agent-xyz</task-id>"));
		assert.ok(!xml.includes("<task-name>"), "no task-name when name is undefined");
		assert.ok(xml.includes("<status>failed</status>"));
		assert.ok(!xml.includes("<usage>"), "no usage when undefined");
	});

	it("omits id when null", () => {
		const xml = buildCoordinatorXml({
			id: null,
			agent: "worker",
			success: true,
			summary: "done",
			exitCode: 0,
			timestamp: Date.now(),
		});

		assert.ok(!xml.includes("<task-id>"));
	});

	it("uses agent name for summary when name is not set", () => {
		const xml = buildCoordinatorXml({
			id: "a1",
			agent: "scout",
			success: true,
			summary: "done",
			exitCode: 0,
			timestamp: Date.now(),
		});

		assert.ok(xml.includes('<summary>Agent "scout" completed</summary>'));
	});

	it("shows failed status for unsuccessful results", () => {
		const xml = buildCoordinatorXml({
			id: "a1",
			agent: "worker",
			name: "builder",
			success: false,
			summary: "Tests failed",
			exitCode: 1,
			timestamp: Date.now(),
		});

		assert.ok(xml.includes("<status>failed</status>"));
		assert.ok(xml.includes('<summary>Agent "builder" failed</summary>'));
	});

	it("handles partial usage (only some fields)", () => {
		const xml = buildCoordinatorXml({
			id: "a1",
			agent: "worker",
			success: true,
			summary: "done",
			exitCode: 0,
			timestamp: Date.now(),
			usage: { totalTokens: 5000 },
		});

		assert.ok(xml.includes("<total_tokens>5000</total_tokens>"));
		assert.ok(!xml.includes("<tool_uses>"));
		assert.ok(!xml.includes("<duration_ms>"));
	});
});

describe("buildMarkdownNotification", () => {
	it("produces existing markdown format", () => {
		const md = buildMarkdownNotification({
			id: "a1",
			agent: "scout",
			success: true,
			summary: "Found the issue",
			exitCode: 0,
			timestamp: Date.now(),
		});

		assert.ok(md.includes("Background task completed: **scout**"));
		assert.ok(md.includes("Found the issue"));
	});

	it("shows failed status", () => {
		const md = buildMarkdownNotification({
			id: "a1",
			agent: "worker",
			success: false,
			summary: "Build error",
			exitCode: 1,
			timestamp: Date.now(),
		});

		assert.ok(md.includes("Background task failed: **worker**"));
	});

	it("includes task index when present", () => {
		const md = buildMarkdownNotification({
			id: "a1",
			agent: "worker",
			success: true,
			summary: "done",
			exitCode: 0,
			timestamp: Date.now(),
			taskIndex: 1,
			totalTasks: 3,
		});

		assert.ok(md.includes("(2/3)"));
	});

	it("includes session URL when present", () => {
		const md = buildMarkdownNotification({
			id: "a1",
			agent: "worker",
			success: true,
			summary: "done",
			exitCode: 0,
			timestamp: Date.now(),
			shareUrl: "https://gist.github.com/abc",
		});

		assert.ok(md.includes("Session: https://gist.github.com/abc"));
	});

	it("uses 'unknown' when agent is null", () => {
		const md = buildMarkdownNotification({
			id: null,
			agent: null,
			success: true,
			summary: "done",
			exitCode: 0,
			timestamp: Date.now(),
		});

		assert.ok(md.includes("**unknown**"));
	});
});

describe("coordinator mode flag", () => {
	afterEach(() => {
		setCoordinatorMode(false);
	});

	it("returns false by default", () => {
		assert.equal(isCoordinatorMode(), false);
	});

	it("returns true when activated", () => {
		setCoordinatorMode(true);
		assert.equal(isCoordinatorMode(), true);
	});

	it("can be toggled back to false", () => {
		setCoordinatorMode(true);
		setCoordinatorMode(false);
		assert.equal(isCoordinatorMode(), false);
	});
});
