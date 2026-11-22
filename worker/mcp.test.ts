import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolApi } from "./tool-api.ts";

const TOOLS = join(import.meta.dirname, "..", "tools");
const env = { BOT_TOKEN_NUTRITION: "nutrition-test", BOT_TOKEN_COACH: "coach-test" } as Env;
const TOKENS = [env.BOT_TOKEN_NUTRITION, env.BOT_TOKEN_COACH];

type Schema = { type?: string; additionalProperties?: unknown; properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[]; allOf?: Schema[] };
type Listed = { name: string; inputSchema: Schema };

async function listTools(api: ToolApi): Promise<Listed[] | null> {
	for (const token of TOKENS) {
		const response = await api(
			new Request("https://tools.test/mcp", {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			}),
			{ env, ctx: { waitUntil() {} } as never, path: "/mcp", db: () => Promise.reject(new Error("tools/list must not touch the database")) },
		);
		if (response.status === 404) return null;
		if (response.status === 200) return ((await response.json()) as { result: { tools: Listed[] } }).result.tools;
	}
	return null;
}

function openObjects(schema: Schema, path: string): string[] {
	const here = schema.type === "object" && schema.additionalProperties !== false ? [path] : [];
	const children = [
		...Object.entries(schema.properties ?? {}).map(([key, child]) => openObjects(child, `${path}.${key}`)),
		...(schema.items === undefined ? [] : [openObjects(schema.items, `${path}[]`)]),
		...[...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].map((child) => openObjects(child, path)),
	];
	return [...here, ...children.flat()];
}

const slugs = readdirSync(TOOLS, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name);

test("every MCP tool rejects argument names it does not know, at every depth", async () => {
	let checked = 0;
	for (const slug of slugs) {
		const api = (await import(join(TOOLS, slug, "api.ts"))).default as ToolApi;
		const tools = await listTools(api);
		if (tools === null) continue;
		checked += tools.length;
		for (const tool of tools) expect({ tool: `${slug}.${tool.name}`, open: openObjects(tool.inputSchema, "arguments") }).toEqual({ tool: `${slug}.${tool.name}`, open: [] });
	}
	expect(checked).toBeGreaterThan(0);
});
