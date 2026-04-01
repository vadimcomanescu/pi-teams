import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	AGENTS_MANAGER_SHORTCUT_KEY,
	AGENTS_MANAGER_SHORTCUT_LABEL,
	RESERVED_SHORTCUT_KEYS,
} from "../shortcut-contract.js";

function readLocal(filePath: string): string {
	return fs.readFileSync(path.resolve(filePath), "utf-8");
}

describe("public team-first contract", () => {
	it("README leads with the team-first workflow and actor-labeled examples", () => {
		const readme = readLocal("README.md");
		const intro = readme.split("## Agents")[0] ?? readme;
		for (const required of [
			"## Team-first workflow",
			"### Primary lead tools",
			"team_create",
			"spawn_teammate",
			"task_create",
			"task_list",
			"check_teammate",
			"team_shutdown",
			"### User says",
			"### Lead calls",
			"### Operator command",
			"/team repo-review",
			"/workers",
			"/stop-all",
			"default_model",
			"<task-notification>",
			"omit `team_name`",
		]) {
			assert.ok(intro.includes(required), `README intro should include ${required}`);
		}
		assert.ok(!intro.includes("--coordinator"), "README should not require a coordinator flag");
	});

	it("installer/help text describes the team-first surface", () => {
		const install = readLocal("install.mjs");
		for (const required of [
			"team orchestration extension",
			"named teammates",
			"shared task boards",
			"Lead sessions use the team coordinator prompt by default",
			"team_create",
			"spawn_teammate",
			"check_teammate",
			"team_shutdown",
			"task_create",
			"task_list",
			"task_read",
			"task_update",
			"team_status",
			"<task-notification>",
			"resolve the current team",
			"/team [team-name]",
			"/workers",
			"/stop-all",
		]) {
			assert.ok(install.includes(required), `installer should include ${required}`);
		}
		assert.ok(install.includes("AGENTS_MANAGER_SHORTCUT_LABEL"), "installer should use the shared shortcut contract");
		assert.ok(!install.includes("--coordinator"), "installer should not require a coordinator flag");
	});

	it("README and slash command keybinding stay consistent for the Agents Manager", () => {
		const readme = readLocal("README.md");
		const slashCommands = readLocal("slash-commands.ts");
		assert.ok(readme.includes(AGENTS_MANAGER_SHORTCUT_LABEL), `README should document ${AGENTS_MANAGER_SHORTCUT_LABEL}`);
		assert.ok(slashCommands.includes("AGENTS_MANAGER_SHORTCUT_KEY"), "slash commands should use the shared shortcut contract");
		for (const reserved of RESERVED_SHORTCUT_KEYS) {
			assert.ok(!slashCommands.includes(`registerShortcut(\"${reserved}\"`), `${reserved} should remain reserved to avoid extension conflicts`);
		}
		assert.notEqual(AGENTS_MANAGER_SHORTCUT_KEY, "ctrl+shift+t", "legacy Ctrl+Shift+T shortcut should not remain");
	});

	it("package metadata and prompts align with the public contract", () => {
		const pkg = JSON.parse(readLocal("package.json")) as { description?: string; keywords?: string[] };
		const prompt = readLocal("coordinator-prompt.ts");
		const coordinatorAgent = readLocal("agents/coordinator.md");
		const workerAgent = readLocal("agents/worker.md");
		assert.equal(pkg.description, "Pi team orchestration extension for named teammates, shared task boards, and raw worker delegation");
		assert.ok(pkg.keywords?.includes("tasks"), "package keywords should include tasks");
		assert.ok(pkg.keywords?.includes("teammates"), "package keywords should include teammates");
		for (const required of ["team_create", "spawn_teammate", "task_list", "check_teammate", "team_shutdown"]) {
			assert.ok(prompt.includes(required), `coordinator prompt should include ${required}`);
			assert.ok(coordinatorAgent.includes(required), `builtin coordinator should include ${required}`);
		}
		assert.ok(prompt.includes("notifications are the primary coordination loop"), "coordinator prompt should teach notification-first coordination");
		assert.ok(prompt.includes("resume an idle teammate"), "coordinator prompt should document teammate continuation");
		assert.ok(prompt.includes("teammates can update task ownership and completion"), "coordinator prompt should describe the shared task board");
		assert.ok(workerAgent.includes("Use task_update to claim or complete tasks"), "worker prompt should teach teammates how to update the shared board");
		assert.ok(!prompt.includes("running-only"), "coordinator prompt should not teach the removed running-only contract");
		assert.ok(!prompt.includes("Task mutation is lead-owned"), "coordinator prompt should not teach the removed lead-owned task canon");
		assert.ok(!workerAgent.includes("Treat task state as lead-owned"), "worker prompt should not teach the removed lead-owned task canon");
		assert.ok(!prompt.includes("--coordinator"), "coordinator prompt should not require a coordinator flag");
		assert.ok(!coordinatorAgent.includes("--coordinator"), "builtin coordinator should not require a coordinator flag");
	});
});
