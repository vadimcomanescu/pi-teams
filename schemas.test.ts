import assert from "node:assert/strict";
import { describe, it } from "node:test";

interface TeamParamsSchema {
	properties?: {
		context?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
	};
}

let TeamParams: TeamParamsSchema | undefined;
let available = true;
try {
	({ TeamParams } = await import("./schemas.ts") as { TeamParams: TeamParamsSchema });
} catch {
	// Skip in environments that do not install typebox.
	available = false;
}

describe("TeamParams schema", { skip: !available ? "typebox not available" : undefined }, () => {
	it("includes context field for fresh/fork execution mode", () => {
		const contextSchema = TeamParams?.properties?.context;
		assert.ok(contextSchema, "context schema should exist");
		assert.equal(contextSchema.type, "string");
		assert.deepEqual(contextSchema.enum, ["fresh", "fork"]);
		assert.match(String(contextSchema.description ?? ""), /fresh/);
		assert.match(String(contextSchema.description ?? ""), /fork/);
	});
});
