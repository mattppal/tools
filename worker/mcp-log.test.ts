import { afterEach, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { argumentNames, defineMcpTool, McpToolError, toolMcp } from "./mcp.ts";

const env = { BOT_TOKEN_NUTRITION: "nutrition-test" } as Env;
const mcp = toolMcp({
	name: "nutrition",
	tools: [
		defineMcpTool({
			name: "log_food",
			description: "test",
			input: z.strictObject({ date: z.string(), add: z.array(z.strictObject({ food: z.string(), kcal: z.number() })).optional() }),
			run: async ({ date }) => {
				if (date === "closed") throw new McpToolError("closed is closed. Reopen it first.");
				return { date };
			},
		}),
	],
});

const log = spyOn(console, "log").mockImplementation(() => {});
afterEach(() => log.mockClear());

async function call(args: unknown): Promise<unknown[]> {
	await mcp(
		new Request("https://tools.test/mcp", {
			method: "POST",
			headers: { authorization: "Bearer nutrition-test", "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "log_food", arguments: args } }),
		}),
		{ env, ctx: { waitUntil() {} } as never, path: "/mcp", db: () => Promise.reject(new Error("unused")) },
	);
	return log.mock.calls.map(([line]) => JSON.parse(String(line)));
}

test("argument names are paths, with arrays marked and no values", () => {
	expect(argumentNames({ date: "2026-11-22", add: [{ food: "egg", kcal: 70 }, { food: "rice", kcal: 200, calories: 1 }], remove: [3, "k"] }).toSorted()).toEqual([
		"add[].calories",
		"add[].food",
		"add[].kcal",
		"date",
		"remove[]",
	]);
});

test("each tools/call logs the bot, the tool, its argument names, and the outcome, never the values", async () => {
	expect(await call({ date: "2026-11-22", add: [{ food: "Secret food", kcal: 70 }] })).toEqual([{ mcp: "nutrition", bot: "nutrition", tool: "log_food", args: ["add[].food", "add[].kcal", "date"], outcome: "ok" }]);
	expect(JSON.stringify(log.mock.calls)).not.toContain("Secret food");
});

test("an unknown argument name logs as invalid with the key it named", async () => {
	expect(await call({ date: "2026-11-22", bodyweight: 180 })).toEqual([
		{ mcp: "nutrition", bot: "nutrition", tool: "log_food", args: ["bodyweight", "date"], outcome: "invalid", reason: expect.stringContaining('Unrecognized key: "bodyweight"') },
	]);
});

test("a rejected write logs as rejected without the tool's message", async () => {
	expect(await call({ date: "closed" })).toEqual([{ mcp: "nutrition", bot: "nutrition", tool: "log_food", args: ["date"], outcome: "rejected" }]);
});
