import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

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
			"running-only",
		]) {
			assert.ok(intro.includes(required), `README intro should include ${required}`);
		}
		assert.ok(!intro.includes("--coordinator"), "README should not require a coordinator flag");
	});

	it("installer/help text describes the team-first surface", () => {
		const install = readLocal("install.mjs");
		for (const required of [
			"managing teams of agents",
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
		]) {
			assert.ok(install.includes(required), `installer should include ${required}`);
		}
		assert.ok(!install.includes("--coordinator"), "installer should not require a coordinator flag");
	});

	it("package metadata and prompts align with the public contract", () => {
		const pkg = JSON.parse(readLocal("package.json")) as { description?: string; keywords?: string[] };
		const prompt = readLocal("coordinator-prompt.ts");
		const coordinatorAgent = readLocal("agents/coordinator.md");
		assert.equal(pkg.description, "Pi extension for managing teams of agents, shared tasks, and raw worker delegation");
		assert.ok(pkg.keywords?.includes("tasks"), "package keywords should include tasks");
		assert.ok(pkg.keywords?.includes("teammates"), "package keywords should include teammates");
		for (const required of ["team_create", "spawn_teammate", "task_list", "check_teammate", "team_shutdown"]) {
			assert.ok(prompt.includes(required), `coordinator prompt should include ${required}`);
			assert.ok(coordinatorAgent.includes(required), `builtin coordinator should include ${required}`);
		}
		assert.ok(prompt.includes("running-only"), "coordinator prompt should document running-only send_message");
		assert.ok(!prompt.includes("--coordinator"), "coordinator prompt should not require a coordinator flag");
		assert.ok(!coordinatorAgent.includes("--coordinator"), "builtin coordinator should not require a coordinator flag");
	});
});
