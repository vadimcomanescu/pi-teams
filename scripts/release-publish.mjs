#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const ALLOW_FLAG = "PI_TEAMS_RELEASE_SCRIPT";

function fail(message) {
	console.error(`\nrelease: ${message}`);
	process.exit(1);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: process.cwd(),
		encoding: "utf8",
		stdio: options.stdio ?? "pipe",
		env: options.env ?? process.env,
	});
	if (result.error) {
		fail(`failed to run ${command} ${args.join(" ")}: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const stderr = result.stderr?.trim();
		const stdout = result.stdout?.trim();
		const details = stderr || stdout || `exit code ${result.status}`;
		fail(`${command} ${args.join(" ")} failed: ${details}`);
	}
	return result.stdout?.trim() ?? "";
}

function checkCleanWorkingTree() {
	const status = run("git", ["status", "--porcelain"]);
	if (status.length > 0) {
		fail("working tree is not clean. Commit or stash changes before release.");
	}
}

function checkBranchSync() {
	const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch !== "main") {
		fail(`release must run from main (current: ${branch}).`);
	}

	run("git", ["fetch", "origin", "--tags"]);
	const counts = run("git", ["rev-list", "--left-right", "--count", "origin/main...HEAD"]);
	const [behindRaw, aheadRaw] = counts.split(/\s+/);
	const behind = Number(behindRaw ?? "0");
	const ahead = Number(aheadRaw ?? "0");
	if (Number.isNaN(behind) || Number.isNaN(ahead)) {
		fail(`unexpected rev-list output: ${counts}`);
	}
	if (behind > 0) {
		fail("HEAD is behind origin/main. Rebase or merge origin/main before release.");
	}
}

function readPackageVersion() {
	const packagePath = path.join(process.cwd(), "package.json");
	const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
	const version = String(pkg.version ?? "").trim();
	if (!version) {
		fail("package.json version is missing.");
	}
	return version;
}

function assertChangelogEntry(version) {
	const changelogPath = path.join(process.cwd(), "CHANGELOG.md");
	const changelog = readFileSync(changelogPath, "utf8");
	const marker = `## [${version}]`;
	if (!changelog.includes(marker)) {
		fail(`CHANGELOG.md is missing ${marker}.`);
	}
}

function ensureTagMissing(tagName) {
	const localTag = spawnSync("git", ["tag", "-l", tagName], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
	if ((localTag.stdout ?? "").trim() === tagName) {
		fail(`${tagName} already exists locally.`);
	}
	const remoteTags = run("git", ["ls-remote", "--tags", "--refs", "origin", tagName]);
	if (remoteTags.length > 0) {
		fail(`${tagName} already exists on origin.`);
	}
}

function publish(version, tagName) {
	console.log(`release: pushing HEAD to origin/main`);
	run("git", ["push", "origin", "HEAD:main"], { stdio: "inherit" });

	console.log(`release: creating tag ${tagName}`);
	run("git", ["tag", "-a", tagName, "-m", `Release ${tagName}`], { stdio: "inherit" });

	console.log(`release: pushing tag ${tagName}`);
	run("git", ["push", "origin", tagName], { stdio: "inherit" });

	console.log(`release: publishing ${version} to npm`);
	run("npm", ["publish"], {
		stdio: "inherit",
		env: {
			...process.env,
			[ALLOW_FLAG]: "1",
		},
	});

	console.log(`release: complete (${version}, ${tagName})`);
}

function main() {
	if (run("git", ["rev-parse", "--is-inside-work-tree"]) !== "true") {
		fail("must run inside a git work tree.");
	}

	checkCleanWorkingTree();
	checkBranchSync();

	const version = readPackageVersion();
	assertChangelogEntry(version);

	const tagName = `v${version}`;
	ensureTagMissing(tagName);

	publish(version, tagName);
}

main();
