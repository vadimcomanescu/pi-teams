/**
 * Team completion notifications (extension)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./completion-dedupe.js";
import { isCoordinatorMode } from "./coordinator.js";
import { buildCoordinatorXml, buildMarkdownNotification } from "./notify-format.js";
import type { NotificationData } from "./notify-format.js";

export default function registerTeamNotify(pi: ExtensionAPI): void {
	const seen = getGlobalSeenMap("__pi_teams_notify_seen__");
	const ttlMs = 10 * 60 * 1000;

	const handleComplete = (data: unknown) => {
		const result = data as NotificationData;
		const now = Date.now();
		const key = buildCompletionKey(result, "notify");
		if (markSeenWithTtl(seen, key, now, ttlMs)) return;

		const coordinatorActive = isCoordinatorMode();
		const content = coordinatorActive
			? buildCoordinatorXml(result)
			: buildMarkdownNotification(result);

		const sendOptions: { triggerTurn: true; deliverAs?: "followUp" } = { triggerTurn: true };
		if (coordinatorActive) {
			sendOptions.deliverAs = "followUp";
		}

		pi.sendMessage(
			{ customType: "team-notify", content, display: true },
			sendOptions,
		);
	};

	pi.events.on("team:complete", handleComplete);
}
