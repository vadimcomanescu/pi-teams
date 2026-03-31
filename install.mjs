#!/usr/bin/env node

/**
 * pi-teams installer
 * 
 * Usage:
 *   npx pi-teams          # Install to ~/.pi/agent/extensions/subagent
 *   npx pi-teams --remove # Remove the extension
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const EXTENSION_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent");
const REPO_URL = "https://github.com/vadimcomanescu/pi-teams.git";

const args = process.argv.slice(2);
const isRemove = args.includes("--remove") || args.includes("-r");
const isHelp = args.includes("--help") || args.includes("-h");

if (isHelp) {
	console.log(`
pi-teams - Pi extension for delegating tasks to subagents with coordinator mode

Usage:
  npx pi-teams          Install the extension
  npx pi-teams --remove Remove the extension
  npx pi-teams --help   Show this help

Installation directory: ${EXTENSION_DIR}
`);
	process.exit(0);
}

if (isRemove) {
	if (fs.existsSync(EXTENSION_DIR)) {
		console.log(`Removing ${EXTENSION_DIR}...`);
		fs.rmSync(EXTENSION_DIR, { recursive: true });
		console.log("✓ pi-subagents removed");
	} else {
		console.log("pi-subagents is not installed");
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
The extension is now available in pi. Tools added:
  • subagent        - Delegate tasks to agents (single, chain, parallel)
  • subagent_status - Check async run status
  • send_message    - Send follow-up messages to running workers (coordinator mode)
  • task_stop       - Stop running workers (coordinator mode)

Documentation: ${EXTENSION_DIR}/README.md
`);
