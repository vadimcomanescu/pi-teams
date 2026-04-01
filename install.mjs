#!/usr/bin/env node

/**
 * pi-teams installer
 * 
 * Usage:
 *   npx pi-teams          # Install to ~/.pi/agent/extensions/pi-teams
 *   npx pi-teams --remove # Remove the extension
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const EXTENSION_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-teams");
const REPO_URL = "https://github.com/vadimcomanescu/pi-teams.git";

const args = process.argv.slice(2);
const isRemove = args.includes("--remove") || args.includes("-r");
const isHelp = args.includes("--help") || args.includes("-h");

if (isHelp) {
	console.log(`
pi-teams - Pi extension for managing teams of agents, shared tasks, and raw worker delegation

Usage:
  npx pi-teams          Install the extension
  npx pi-teams --remove Remove the extension
  npx pi-teams --help   Show this help

Lead sessions use the team coordinator prompt by default.
Installation directory: ${EXTENSION_DIR}
`);
	process.exit(0);
}

if (isRemove) {
	if (fs.existsSync(EXTENSION_DIR)) {
		console.log(`Removing ${EXTENSION_DIR}...`);
		fs.rmSync(EXTENSION_DIR, { recursive: true });
		console.log("✓ pi-teams removed");
	} else {
		console.log("pi-teams is not installed");
	}
	process.exit(0);
}

// Install
console.log("Installing pi-teams...\n");

// Ensure parent directory exists
const parentDir = path.dirname(EXTENSION_DIR);
if (!fs.existsSync(parentDir)) {
	fs.mkdirSync(parentDir, { recursive: true });
}

// Check if already installed
if (fs.existsSync(EXTENSION_DIR)) {
	const isGitRepo = fs.existsSync(path.join(EXTENSION_DIR, ".git"));
	if (isGitRepo) {
		console.log("Updating existing installation...");
		try {
			execSync("git pull", { cwd: EXTENSION_DIR, stdio: "inherit" });
			console.log("\n✓ pi-teams updated");
		} catch (err) {
			console.error("Failed to update. Try removing and reinstalling:");
			console.error("  npx pi-teams --remove && npx pi-teams");
			process.exit(1);
		}
	} else {
		console.log(`Directory exists but is not a git repo: ${EXTENSION_DIR}`);
		console.log("Remove it first with: npx pi-teams --remove");
		process.exit(1);
	}
} else {
	// Fresh install
	console.log(`Cloning to ${EXTENSION_DIR}...`);
	try {
		execSync(`git clone ${REPO_URL} "${EXTENSION_DIR}"`, { stdio: "inherit" });
		console.log("\n✓ pi-teams installed");
	} catch (err) {
		console.error("Failed to clone repository");
		process.exit(1);
	}
}

console.log(`
The extension is now available in pi.

Primary lead tools:
  • team_create     - Create the active team for this lead session
  • spawn_teammate  - Launch a named teammate inside that team
  • check_teammate  - Inspect teammate status and last summary
  • team_shutdown   - Stop the active team
  • task_create     - Add a shared team task
  • task_list       - List shared team tasks
  • task_read       - Read one shared team task
  • task_update     - Update task status or owner

Advanced worker tools:
  • team            - Delegate raw worker execution (single, chain, parallel)
  • team_status     - Check async raw worker run status
  • send_message    - Follow up with a running teammate, or resume an idle teammate with a session
  • task_stop       - Stop a running teammate or worker

Notification-first coordination:
  • Teammate completions arrive automatically as <task-notification> messages
  • Omit team_name after team_create, follow-up tools resolve the current team
  • Use check_teammate only when you need an explicit inspection snapshot

Operator visibility commands:
  • /team [team-name] - Show the active team, teammates, and shared tasks
  • /workers          - List running workers in the current lead session
  • /stop-all         - Stop all running workers in the current lead session

Agents Manager shortcut:
  • Ctrl+Shift+A      - Open the Agents Manager overlay

Documentation: ${EXTENSION_DIR}/README.md
`);
