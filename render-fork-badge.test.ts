import assert from "node:assert/strict";
import { describe, it } from "node:test";

type RenderTeamResult = (
	result: {
		content: Array<{ type: "text"; text: string }>;
		details?: {
			mode: "single" | "parallel" | "chain" | "management";
			context?: "fresh" | "fork";
			results: unknown[];
		};
	},
	options: { expanded: boolean },
	theme: {
		fg(name: string, text: string): string;
		bold(text: string): string;
	},
) => { render(width: number): string[] };

let renderTeamResult: RenderTeamResult | undefined;
let available = true;
try {
	({ renderTeamResult } = await import("./render.ts") as {
		renderTeamResult?: RenderTeamResult;
	});
} catch {
	// Skip in plain unit mode where render.ts dependencies are unavailable.
	available = false;
}

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

describe("renderTeamResult fork indicator", { skip: !available ? "render.ts not importable" : undefined }, () => {
	it("shows [fork] when details are empty but context is fork", () => {
		const widget = renderTeamResult!({
			content: [{ type: "text", text: "Async: reviewer [abc123]" }],
			details: { mode: "single", context: "fork", results: [] },
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /\[fork\]/);
	});

	it("shows [fork] on single-result header", () => {
		const widget = renderTeamResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				context: "fork",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						turns: 0,
					},
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /\[fork\]/);
	});
});
