/**
 * E2E test: extension loading and tool registration.
 *
 * Uses pi-test-harness createTestSession to verify that the extension
 * loads correctly and both tools respond to calls.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { tryImport } from "./helpers.ts";

const harness = await tryImport<any>("@marcfargas/pi-test-harness");
const available = !!harness;

const EXTENSION = path.resolve("index.ts");

describe("extension loading", { skip: !available ? "pi-test-harness not available" : undefined }, () => {
	const { createTestSession, when, calls, says } = harness;
	let t: any;

	afterEach(() => t?.dispose());

	it("loads extension and team tool responds", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
		});

		await t.run(
			when("List agents", [
				calls("team", { action: "list" }),
				says("Done."),
			]),
		);

		const results = t.events.toolResultsFor("team");
		assert.equal(results.length, 1, "team tool should respond");
		assert.ok(!results[0].isError, "should not be an error");
	});

	it("team_status tool responds", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
		});

		await t.run(
			when("Check status", [
				calls("team_status", { id: "nonexistent" }),
				says("Not found."),
			]),
		);

		const results = t.events.toolResultsFor("team_status");
		assert.equal(results.length, 1, "team_status tool should respond");
		// Nonexistent ID → error result
		assert.ok(results[0].isError, "should be an error for missing ID");
		assert.ok(results[0].text.includes("not found") || results[0].text.includes("Provide"));
	});

	it("first-class team tools support the README-style team workflow", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
		});
		const teamName = `repo-review-${Date.now()}`;

		await t.run(
			when("Create a review team", [
				calls("team_create", { team_name: teamName, description: "Review team" }),
				calls("task_create", { team_name: teamName, subject: "Architecture review", description: "Assess architecture." }),
				calls("task_list", { team_name: teamName }),
				calls("team_shutdown", { team_name: teamName }),
				says("Done."),
			]),
		);

		assert.equal(t.events.toolResultsFor("team_create").length, 1, "team_create should respond");
		assert.equal(t.events.toolResultsFor("task_create").length, 1, "task_create should respond");
		assert.equal(t.events.toolResultsFor("task_list").length, 1, "task_list should respond");
		assert.equal(t.events.toolResultsFor("team_shutdown").length, 1, "team_shutdown should respond");
		assert.ok(!t.events.toolResultsFor("team_create")[0].isError, "team_create should succeed");
		assert.ok(!t.events.toolResultsFor("task_create")[0].isError, "task_create should succeed");
		assert.ok(!t.events.toolResultsFor("task_list")[0].isError, "task_list should succeed");
		assert.ok(!t.events.toolResultsFor("team_shutdown")[0].isError, "team_shutdown should succeed");
	});
});
