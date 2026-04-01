/**
 * E2E tests: team tool behavior through the real pi runtime.
 *
 * Uses pi-test-harness createTestSession to test the tool handler with
 * playbook-scripted model actions. The extension loads for real, tools
 * register for real, hooks fire for real — only the model is replaced.
 *
 * For execution tests (single, chain, parallel), createMockPi() from
 * @marcfargas/pi-test-harness handles the spawned team processes.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "./helpers.ts";
import { createMockPi, tryImport } from "./helpers.ts";

const harness = await tryImport<any>("@marcfargas/pi-test-harness");
const available = !!harness;

// Install mock pi for execution tests
let mockPi: MockPi | undefined;
if (available) {
	mockPi = createMockPi();
	mockPi.install();
	process.on("exit", () => mockPi?.uninstall());
}

const EXTENSION = path.resolve("index.ts");

/**
 * Write test agent definitions as .md files with YAML frontmatter.
 * Agent discovery only reads .md files, not .yaml.
 */
function writeTestAgents(cwd: string, agents: Array<{ name: string; description?: string; model?: string }>) {
	const agentsDir = path.join(cwd, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	for (const agent of agents) {
		const frontmatter = [
			"---",
			`name: ${agent.name}`,
			`description: ${agent.description ?? `Test agent ${agent.name}`}`,
			agent.model ? `model: ${agent.model}` : null,
			"---",
		]
			.filter(Boolean)
			.join("\n");
		const content = `${frontmatter}\n\nYou are a test agent named ${agent.name}.\n`;
		fs.writeFileSync(path.join(agentsDir, `${agent.name}.md`), content);
	}
}

describe("team tool — management", { skip: !available ? "pi-test-harness not available" : undefined }, () => {
	const { createTestSession, when, calls, says } = harness;
	let t: any;

	afterEach(() => {
		t?.dispose();
		mockPi?.reset();
	});

	it("action: list returns discovered agents (project scope)", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: {
				bash: "ok",
				read: "ok",
				write: "ok",
				edit: "ok",
			},
		});

		// Write test agents into the session's cwd (project scope)
		writeTestAgents(t.cwd, [
			{ name: "scout", description: "Reconnaissance agent" },
			{ name: "writer", description: "Documentation writer" },
		]);

		await t.run(
			when("List available agents", [
				calls("team", { action: "list", agentScope: "project" }),
				says("Found the agents."),
			]),
		);

		const results = t.events.toolResultsFor("team");
		assert.equal(results.length, 1);
		assert.ok(!results[0].isError, "should not be an error");
		assert.ok(results[0].text.includes("scout"), `should list scout: ${results[0].text.slice(0, 200)}`);
		assert.ok(results[0].text.includes("writer"), `should list writer: ${results[0].text.slice(0, 200)}`);
	});

	it("action: get returns agent detail", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
		});

		writeTestAgents(t.cwd, [{ name: "scout", description: "Recon agent" }]);

		await t.run(
			when("Get scout agent details", [
				calls("team", { action: "get", agent: "scout", agentScope: "project" }),
				says("Here are the details."),
			]),
		);

		const results = t.events.toolResultsFor("team");
		assert.equal(results.length, 1);
		assert.ok(!results[0].isError);
		assert.ok(results[0].text.includes("scout"));
	});
});

describe("team tool — validation", { skip: !available ? "pi-test-harness not available" : undefined }, () => {
	const { createTestSession, when, calls, says } = harness;
	let t: any;

	afterEach(() => {
		t?.dispose();
		mockPi?.reset();
	});

	it("rejects invalid action", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
		});

		await t.run(
			when("Do something invalid", [
				calls("team", { action: "invalid_action" }),
				says("That failed."),
			]),
		);

		const results = t.events.toolResultsFor("team");
		assert.equal(results.length, 1);
		assert.ok(results[0].isError, "should be an error");
		assert.ok(results[0].text.includes("Unknown action"));
	});

	it("rejects ambiguous mode (both agent+task and chain)", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
		});

		await t.run(
			when("Ambiguous call", [
				calls("team", {
					agent: "test",
					task: "do something",
					chain: [{ agent: "a", task: "start" }],
				}),
				says("That's ambiguous."),
			]),
		);

		const results = t.events.toolResultsFor("team");
		assert.equal(results.length, 1);
		assert.ok(results[0].isError, "should be an error");
		assert.ok(results[0].text.includes("exactly one mode") || results[0].text.includes("Provide exactly one"));
	});

	it("rejects unknown agent in single mode", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
		});

		await t.run(
			when("Call nonexistent agent", [
				calls("team", { agent: "nonexistent_agent_xyz", task: "hello" }),
				says("Agent not found."),
			]),
		);

		const results = t.events.toolResultsFor("team");
		assert.equal(results.length, 1);
		assert.ok(results[0].isError, "should be an error");
		assert.ok(results[0].text.includes("Unknown") || results[0].text.includes("nonexistent"));
	});

	it("rejects chain with unknown agent", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
		});

		writeTestAgents(t.cwd, [{ name: "scout" }]);

		await t.run(
			when("Chain with bad agent", [
				calls("team", {
					chain: [
						{ agent: "scout", task: "start" },
						{ agent: "nonexistent_agent_xyz" },
					],
					agentScope: "project",
				}),
				says("Unknown agent in chain."),
			]),
		);

		const results = t.events.toolResultsFor("team");
		assert.equal(results.length, 1);
		assert.ok(results[0].isError, "should be an error");
		assert.ok(results[0].text.includes("Unknown agent") || results[0].text.includes("nonexistent"));
	});

	it("rejects empty chain", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
		});

		await t.run(
			when("Empty chain", [
				calls("team", { chain: [] }),
				says("Chain must have steps."),
			]),
		);

		const results = t.events.toolResultsFor("team");
		assert.equal(results.length, 1);
		assert.ok(results[0].isError);
	});
});

describe("team tool — single execution", { skip: !available ? "pi-test-harness not available" : undefined }, () => {
	const { createTestSession, when, calls, says } = harness;
	let t: any;

	afterEach(() => {
		t?.dispose();
		mockPi?.reset();
	});

	it("executes single agent and returns output", async () => {
		mockPi?.onCall({ output: "Hello from the team!" });

		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
		});

		writeTestAgents(t.cwd, [{ name: "echo" }]);

		await t.run(
			when("Run the echo agent", [
				calls("team", { agent: "echo", task: "Say hello", clarify: false, agentScope: "project" }),
				says("The agent responded."),
			]),
		);

		const results = t.events.toolResultsFor("team");
		assert.equal(results.length, 1);
		assert.ok(!results[0].isError, `should succeed: ${results[0].text.slice(0, 200)}`);
		assert.ok(results[0].text.includes("Hello from the team"), `should contain output: ${results[0].text.slice(0, 200)}`);
	});

	it("returns error for failed agent", async () => {
		mockPi?.onCall({ exitCode: 1, stderr: "Agent crashed hard" });

		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
		});

		writeTestAgents(t.cwd, [{ name: "crasher" }]);

		await t.run(
			when("Run the crasher", [
				calls("team", { agent: "crasher", task: "Crash please", clarify: false, agentScope: "project" }),
				says("It failed."),
			]),
		);

		const results = t.events.toolResultsFor("team");
		assert.equal(results.length, 1);
		assert.ok(results[0].isError, "should be an error");
	});
});
