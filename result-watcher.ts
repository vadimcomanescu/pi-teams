import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.js";
import { createFileCoalescer } from "./file-coalescer.js";
import type { TeamState } from "./types.js";

export function createResultWatcher(
	pi: ExtensionAPI,
	state: TeamState,
	resultsDir: string,
	completionTtlMs: number,
): {
	startResultWatcher: () => void;
	primeExistingResults: () => void;
	stopResultWatcher: () => void;
} {
	const handleResult = (file: string) => {
		const resultPath = path.join(resultsDir, file);
		if (!fs.existsSync(resultPath)) return;
		try {
			const data = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
				sessionId?: string;
				cwd?: string;
			};
			if (data.sessionId && data.sessionId !== state.currentSessionId) return;
			if (!data.sessionId && data.cwd && data.cwd !== state.baseCwd) return;

			const now = Date.now();
			const completionKey = buildCompletionKey(data, `result:${file}`);
			if (markSeenWithTtl(state.completionSeen, completionKey, now, completionTtlMs)) {
				try {
					fs.unlinkSync(resultPath);
				} catch {}
				return;
			}

			pi.events.emit("team:complete", data);
			fs.unlinkSync(resultPath);
		} catch {}
	};

	state.resultFileCoalescer = createFileCoalescer(handleResult, 50);

	const startResultWatcher = () => {
		state.watcherRestartTimer = null;
		try {
			state.watcher = fs.watch(resultsDir, (ev, file) => {
				if (ev !== "rename" || !file) return;
				const fileName = file.toString();
				if (!fileName.endsWith(".json")) return;
				state.resultFileCoalescer.schedule(fileName);
			});
			state.watcher.on("error", () => {
				state.watcher = null;
				state.watcherRestartTimer = setTimeout(() => {
					try {
						fs.mkdirSync(resultsDir, { recursive: true });
						startResultWatcher();
					} catch {}
				}, 3000);
			});
			state.watcher.unref?.();
		} catch {
			state.watcher = null;
			state.watcherRestartTimer = setTimeout(() => {
				try {
					fs.mkdirSync(resultsDir, { recursive: true });
					startResultWatcher();
				} catch {}
			}, 3000);
		}
	};

	const primeExistingResults = () => {
		fs.readdirSync(resultsDir)
			.filter((f) => f.endsWith(".json"))
			.forEach((file) => state.resultFileCoalescer.schedule(file, 0));
	};

	const stopResultWatcher = () => {
		state.watcher?.close();
		state.watcher = null;
		if (state.watcherRestartTimer) {
			clearTimeout(state.watcherRestartTimer);
		}
		state.watcherRestartTimer = null;
		state.resultFileCoalescer.clear();
	};

	return { startResultWatcher, primeExistingResults, stopResultWatcher };
}
