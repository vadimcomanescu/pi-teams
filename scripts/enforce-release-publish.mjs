#!/usr/bin/env node

const ALLOW_FLAG = "PI_TEAMS_RELEASE_SCRIPT";

if (process.env[ALLOW_FLAG] === "1") {
	process.exit(0);
}

console.error(
	[
		"Direct npm publish is blocked for this repository.",
		"Use `npm run release:publish` so git push + git tag happen before publish.",
		`If you must bypass in an emergency, set ${ALLOW_FLAG}=1 explicitly.`,
	].join("\n"),
);
process.exit(1);
