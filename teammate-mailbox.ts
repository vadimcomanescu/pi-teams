import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLock, writeJsonAtomically } from "./state-file-utils.js";

export type MailboxPayload =
	| { type: "plain_text"; text: string; summary?: string }
	| { type: "shutdown_response"; requestId: string; approve: boolean; reason?: string };

export interface TeamMailboxMessage {
	id: string;
	from: string;
	to: string;
	createdAt: number;
	payload: MailboxPayload;
}

interface StoredMailboxMessage extends TeamMailboxMessage {
	readAt?: number;
}

interface MailboxDocument {
	version: 1;
	messages: StoredMailboxMessage[];
}

const MAILBOX_DIR = "mailboxes";

function normalizeRecipient(recipient: string): string {
	const normalized = recipient.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
	if (!normalized || normalized === "." || normalized === "..") {
		throw new Error(`Invalid mailbox recipient: ${recipient}`);
	}
	return normalized;
}

function getMailboxPath(teamDir: string, recipient: string): string {
	return path.join(teamDir, MAILBOX_DIR, `${normalizeRecipient(recipient)}.json`);
}

function readMailbox(pathname: string): MailboxDocument {
	if (!fs.existsSync(pathname)) {
		return { version: 1, messages: [] };
	}
	const raw = fs.readFileSync(pathname, "utf-8");
	if (!raw.trim()) return { version: 1, messages: [] };
	const parsed = JSON.parse(raw) as MailboxDocument;
	if (parsed.version !== 1 || !Array.isArray(parsed.messages)) {
		throw new Error(`Corrupt mailbox file: ${pathname}`);
	}
	return {
		version: 1,
		messages: parsed.messages,
	};
}

function writeMailbox(pathname: string, document: MailboxDocument): void {
	writeJsonAtomically(pathname, document);
}

export function enqueueMailboxMessage(
	teamDir: string,
	recipient: string,
	message: Omit<TeamMailboxMessage, "id" | "createdAt">,
): TeamMailboxMessage {
	const mailboxPath = getMailboxPath(teamDir, recipient);
	return withFileLock(mailboxPath, () => {
		const document = readMailbox(mailboxPath);
		const stored: StoredMailboxMessage = {
			...message,
			id: randomUUID(),
			createdAt: Date.now(),
		};
		document.messages.push(stored);
		writeMailbox(mailboxPath, document);
		return {
			id: stored.id,
			from: stored.from,
			to: stored.to,
			createdAt: stored.createdAt,
			payload: stored.payload,
		};
	});
}

export function readUnreadMailboxMessages(teamDir: string, recipient: string): TeamMailboxMessage[] {
	const mailboxPath = getMailboxPath(teamDir, recipient);
	return withFileLock(mailboxPath, () => {
		const document = readMailbox(mailboxPath);
		return document.messages
			.filter((entry) => entry.readAt === undefined)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((entry) => ({
				id: entry.id,
				from: entry.from,
				to: entry.to,
				createdAt: entry.createdAt,
				payload: entry.payload,
			}));
	});
}

export function markMailboxMessagesRead(teamDir: string, recipient: string, messageIds: string[]): void {
	if (messageIds.length === 0) return;
	const mailboxPath = getMailboxPath(teamDir, recipient);
	const wanted = new Set(messageIds);
	withFileLock(mailboxPath, () => {
		const document = readMailbox(mailboxPath);
		let changed = false;
		for (const entry of document.messages) {
			if (entry.readAt !== undefined) continue;
			if (!wanted.has(entry.id)) continue;
			entry.readAt = Date.now();
			changed = true;
		}
		if (changed) {
			writeMailbox(mailboxPath, document);
		}
	});
}
