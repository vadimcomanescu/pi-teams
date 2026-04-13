import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	enqueueMailboxMessage,
	markMailboxMessagesRead,
	readUnreadMailboxMessages,
} from "./teammate-mailbox.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-mailbox-"));
}

describe("teammate mailbox", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop()!;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("queues and reads unread messages in FIFO order", () => {
		const teamDir = makeTempDir();
		tempDirs.push(teamDir);

		const first = enqueueMailboxMessage(teamDir, "docs", {
			from: "lead",
			to: "docs",
			payload: { type: "plain_text", text: "first", summary: "one" },
		});
		const second = enqueueMailboxMessage(teamDir, "docs", {
			from: "lead",
			to: "docs",
			payload: { type: "plain_text", text: "second", summary: "two" },
		});

		const unread = readUnreadMailboxMessages(teamDir, "docs");
		assert.equal(unread.length, 2);
		assert.equal(unread[0]?.id, first.id);
		assert.equal(unread[1]?.id, second.id);
	});

	it("marks only selected messages as read", () => {
		const teamDir = makeTempDir();
		tempDirs.push(teamDir);

		const first = enqueueMailboxMessage(teamDir, "docs", {
			from: "lead",
			to: "docs",
			payload: { type: "plain_text", text: "first" },
		});
		const second = enqueueMailboxMessage(teamDir, "docs", {
			from: "lead",
			to: "docs",
			payload: { type: "plain_text", text: "second" },
		});

		markMailboxMessagesRead(teamDir, "docs", [first.id]);
		const unread = readUnreadMailboxMessages(teamDir, "docs");
		assert.deepEqual(unread.map((entry) => entry.id), [second.id]);
	});

	it("isolates mailboxes by recipient", () => {
		const teamDir = makeTempDir();
		tempDirs.push(teamDir);

		enqueueMailboxMessage(teamDir, "docs", {
			from: "lead",
			to: "docs",
			payload: { type: "plain_text", text: "docs message" },
		});
		enqueueMailboxMessage(teamDir, "lead", {
			from: "docs",
			to: "lead",
			payload: { type: "shutdown_response", requestId: "req-1", approve: false, reason: "still working" },
		});

		const docsUnread = readUnreadMailboxMessages(teamDir, "docs");
		const leadUnread = readUnreadMailboxMessages(teamDir, "lead");
		assert.equal(docsUnread.length, 1);
		assert.equal(leadUnread.length, 1);
		assert.equal(docsUnread[0]?.payload.type, "plain_text");
		assert.equal(leadUnread[0]?.payload.type, "shutdown_response");
	});
});
