/**
 * Pure notification formatting functions.
 * No dependencies — safe to import from tests and from notify.ts.
 */

export interface NotificationData {
	id: string | null;
	agent: string | null;
	name?: string;
	success: boolean;
	summary: string;
	exitCode: number;
	timestamp: number;
	sessionFile?: string;
	shareUrl?: string;
	shareError?: string;
	taskIndex?: number;
	totalTasks?: number;
	usage?: {
		totalTokens?: number;
		toolUses?: number;
		durationMs?: number;
	};
}

/**
 * Coordinator XML format for structured LLM consumption.
 */
export function buildCoordinatorXml(result: NotificationData): string {
	const status = result.success ? "completed" : "failed";
	const name = result.name ?? result.agent ?? "unknown";

	const parts: string[] = ["<task-notification>"];
	if (result.id) parts.push(`<task-id>${result.id}</task-id>`);
	if (result.name) parts.push(`<task-name>${result.name}</task-name>`);
	parts.push(`<status>${status}</status>`);
	parts.push(`<summary>Agent "${name}" ${status}</summary>`);
	if (result.summary) parts.push(`<result>${result.summary}</result>`);
	if (result.usage) {
		const usageParts: string[] = ["<usage>"];
		if (result.usage.totalTokens !== undefined) {
			usageParts.push(`  <total_tokens>${result.usage.totalTokens}</total_tokens>`);
		}
		if (result.usage.toolUses !== undefined) {
			usageParts.push(`  <tool_uses>${result.usage.toolUses}</tool_uses>`);
		}
		if (result.usage.durationMs !== undefined) {
			usageParts.push(`  <duration_ms>${result.usage.durationMs}</duration_ms>`);
		}
		usageParts.push("</usage>");
		parts.push(usageParts.join("\n"));
	}
	parts.push("</task-notification>");
	return parts.join("\n");
}

/**
 * Default markdown format for human-readable notifications.
 */
export function buildMarkdownNotification(result: NotificationData): string {
	const agent = result.agent ?? "unknown";
	const status = result.success ? "completed" : "failed";

	const taskInfo =
		result.taskIndex !== undefined && result.totalTasks !== undefined
			? ` (${result.taskIndex + 1}/${result.totalTasks})`
			: "";

	const extra: string[] = [];
	if (result.shareUrl) {
		extra.push(`Session: ${result.shareUrl}`);
	} else if (result.shareError) {
		extra.push(`Session share error: ${result.shareError}`);
	} else if (result.sessionFile) {
		extra.push(`Session file: ${result.sessionFile}`);
	}

	return [
		`Background task ${status}: **${agent}**${taskInfo}`,
		"",
		result.summary,
		extra.length ? "" : undefined,
		extra.length ? extra.join("\n") : undefined,
	]
		.filter((line) => line !== undefined)
		.join("\n");
}
