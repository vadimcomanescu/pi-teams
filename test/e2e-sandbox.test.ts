/**
 * E2E test: extension loading and tool registration.
 *
 * Uses pi-test-harness createTestSession to verify that the extension
 * loads correctly and both tools respond to calls.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../agent-registry.js";
import { TaskStore } from "../task-store.js";
import { TeamManager } from "../team-manager.js";
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

	it("teammate runtime exposes task_update and can claim its own task", async () => {
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		const originalRuntimeRole = process.env.PI_TEAMS_RUNTIME_ROLE;
		const originalTeamName = process.env.PI_TEAMS_TEAM_NAME;
		const originalTeammateName = process.env.PI_TEAMS_TEAMMATE_NAME;
		const originalTeammateNames = process.env.PI_TEAMS_TEAMMATE_NAMES_JSON;
		const originalAssignedTaskIds = process.env.PI_TEAMS_ASSIGNED_TASK_IDS_JSON;
		const originalConfigPath = process.env.PI_TEAMS_TEAM_CONFIG_PATH;
		const originalTasksPath = process.env.PI_TEAMS_TEAM_TASKS_PATH;
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-home-"));
		const teamsRoot = path.join(tempHome, ".pi", "teams");
		const registry = new AgentRegistry();
		const manager = new TeamManager({
			registry,
			rootDir: teamsRoot,
			getCurrentSessionId: () => "lead-session",
			getCurrentTeammateTeamName: () => null,
			getCurrentTeammateName: () => null,
		});
		const team = manager.createTeam({ team_name: "repo-review" });
		const store = new TaskStore(team.name, manager.getTasksPath(team.name));
		const task = store.createTask("Docs review", "Check README");

		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		process.env.PI_TEAMS_RUNTIME_ROLE = "teammate";
		process.env.PI_TEAMS_TEAM_NAME = team.name;
		process.env.PI_TEAMS_TEAMMATE_NAME = "docs";
		process.env.PI_TEAMS_TEAMMATE_NAMES_JSON = JSON.stringify(["docs"]);
		process.env.PI_TEAMS_ASSIGNED_TASK_IDS_JSON = JSON.stringify([task.id]);
		process.env.PI_TEAMS_TEAM_CONFIG_PATH = manager.getConfigPath(team.name);
		process.env.PI_TEAMS_TEAM_TASKS_PATH = manager.getTasksPath(team.name);

		try {
			t = await createTestSession({
				extensions: [EXTENSION],
				cwd: tempHome,
				mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
			});

			await t.run(
				when("Claim a teammate task", [
					calls("task_update", { task_id: task.id, status: "in_progress" }),
					calls("task_list", {}),
					says("Claimed."),
				]),
			);

			assert.equal(t.events.toolResultsFor("task_update").length, 1, "task_update should be available to teammates");
			assert.ok(!t.events.toolResultsFor("task_update")[0].isError, "task_update should succeed for teammates");
			assert.equal(store.readTask(task.id)?.owner, "docs");
			assert.equal(store.readTask(task.id)?.status, "in_progress");
		} finally {
			t?.dispose();
			t = undefined;
			if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
			if (originalRuntimeRole === undefined) delete process.env.PI_TEAMS_RUNTIME_ROLE; else process.env.PI_TEAMS_RUNTIME_ROLE = originalRuntimeRole;
			if (originalTeamName === undefined) delete process.env.PI_TEAMS_TEAM_NAME; else process.env.PI_TEAMS_TEAM_NAME = originalTeamName;
			if (originalTeammateName === undefined) delete process.env.PI_TEAMS_TEAMMATE_NAME; else process.env.PI_TEAMS_TEAMMATE_NAME = originalTeammateName;
			if (originalTeammateNames === undefined) delete process.env.PI_TEAMS_TEAMMATE_NAMES_JSON; else process.env.PI_TEAMS_TEAMMATE_NAMES_JSON = originalTeammateNames;
			if (originalAssignedTaskIds === undefined) delete process.env.PI_TEAMS_ASSIGNED_TASK_IDS_JSON; else process.env.PI_TEAMS_ASSIGNED_TASK_IDS_JSON = originalAssignedTaskIds;
			if (originalConfigPath === undefined) delete process.env.PI_TEAMS_TEAM_CONFIG_PATH; else process.env.PI_TEAMS_TEAM_CONFIG_PATH = originalConfigPath;
			if (originalTasksPath === undefined) delete process.env.PI_TEAMS_TEAM_TASKS_PATH; else process.env.PI_TEAMS_TEAM_TASKS_PATH = originalTasksPath;
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});
});
