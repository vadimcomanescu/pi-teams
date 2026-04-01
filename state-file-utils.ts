import * as fs from "node:fs";
import * as path from "node:path";

function sleepMs(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface FileLockOptions {
	timeoutMs?: number;
	retryDelayMs?: number;
}

export function withFileLock<T>(
	lockTargetPath: string,
	callback: () => T,
	options: FileLockOptions = {},
): T {
	const timeoutMs = options.timeoutMs ?? 1_000;
	const retryDelayMs = options.retryDelayMs ?? 10;
	const lockPath = `${lockTargetPath}.lock`;
	fs.mkdirSync(path.dirname(lockTargetPath), { recursive: true });
	const startedAt = Date.now();
	let fd: number | null = null;

	while (fd === null) {
		try {
			fd = fs.openSync(lockPath, "wx");
			fs.writeFileSync(fd, String(process.pid));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") {
				throw error;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error(`Timed out acquiring file lock: ${lockPath}`);
			}
			sleepMs(retryDelayMs);
		}
	}

	try {
		return callback();
	} finally {
		if (fd !== null) {
			fs.closeSync(fd);
		}
		try {
			fs.unlinkSync(lockPath);
		} catch {
			// Best effort cleanup.
		}
	}
}

export function writeJsonAtomically(filePath: string, data: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
	fs.renameSync(tempPath, filePath);
}
