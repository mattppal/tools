import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { type BotName, requireBot } from "./bot-auth.ts";
import type { ToolApiContext } from "./tool-api.ts";

export type McpToolContext = ToolApiContext & { bot: BotName };

export type McpTool<Input extends z.ZodObject = z.ZodObject> = {
	name: string;
	description: string;
	input: Input;
	readOnly?: boolean;
	run: (args: z.infer<Input>, context: McpToolContext) => Promise<unknown>;
};

export class McpToolError extends Error {}

export function defineMcpTool<Input extends z.ZodObject>(tool: McpTool<Input>): McpTool {
	return tool as unknown as McpTool;
}

function result(value: unknown): CallToolResult {
	const text = JSON.stringify(value ?? null);
	const structured = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	return structured === undefined ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text }], structuredContent: structured };
}

function failure(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

export function toolMcp({ name, tools }: { name: string; tools: readonly McpTool[] }) {
	return async (request: Request, context: ToolApiContext): Promise<Response> => {
		if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: { allow: "POST" } });
		const bot = await requireBot(request, context.env, name);
		if (bot instanceof Response) return bot;

		const server = new McpServer({ name: `tools-${name}`, version: "1.0.0" });
		for (const tool of tools) {
			server.registerTool(
				tool.name,
				{ description: tool.description, inputSchema: tool.input, annotations: { readOnlyHint: tool.readOnly ?? false } },
				async (args: unknown) => {
					try {
						return result(await tool.run(args as z.infer<typeof tool.input>, { ...context, bot }));
					} catch (error) {
						if (error instanceof McpToolError) return failure(error.message);
						console.error(`MCP tool ${name}.${tool.name} failed`, error);
						return failure("Internal error");
					}
				},
			);
		}
		const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		await server.connect(transport);
		const sent: unknown = await request
			.clone()
			.json()
			.catch(() => null);
		const response = await transport.handleRequest(request);
		const answered: unknown = response.headers.get("content-type")?.includes("application/json") ? await response.clone().json() : null;
		for (const line of callLog(name, bot, sent, answered)) console.log(JSON.stringify(line));
		return response;
	};
}

type Message = { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown }; result?: { isError?: unknown; content?: { text?: unknown }[] }; error?: { message?: unknown } };

export type CallLogLine = { mcp: string; bot: BotName; tool: string; args: string[]; outcome: "ok" | "rejected" | "invalid" | "protocol error" | "no response"; reason?: string };

export function argumentNames(value: unknown, prefix = ""): string[] {
	if (Array.isArray(value)) return [...new Set(value.flatMap((item) => argumentNames(item, `${prefix}[]`)))];
	if (value === null || typeof value !== "object") return prefix === "" ? [] : [prefix];
	const names = Object.entries(value).flatMap(([key, child]) => {
		const path = prefix === "" ? key : `${prefix}.${key}`;
		const nested = argumentNames(child, path);
		return nested.length === 0 ? [path] : nested;
	});
	return [...new Set(names)];
}

function messages(body: unknown): Message[] {
	return (Array.isArray(body) ? body : [body]).filter((item): item is Message => item !== null && typeof item === "object");
}

export function callLog(mcp: string, bot: BotName, sent: unknown, answered: unknown): CallLogLine[] {
	const replies = new Map(messages(answered).map((reply) => [JSON.stringify(reply.id ?? null), reply]));
	return messages(sent)
		.filter((message) => message.method === "tools/call")
		.map((message) => {
			const reply = replies.get(JSON.stringify(message.id ?? null));
			const line: CallLogLine = { mcp, bot, tool: String(message.params?.name ?? ""), args: argumentNames(message.params?.arguments).toSorted(), outcome: "ok" };
			if (reply === undefined) return { ...line, outcome: "no response" };
			if (reply.error !== undefined) return { ...line, outcome: "protocol error", reason: String(reply.error.message ?? "") };
			if (reply.result?.isError !== true) return line;
			const text = String(reply.result.content?.[0]?.text ?? "");
			return text.startsWith("MCP error -32602") ? { ...line, outcome: "invalid", reason: text } : { ...line, outcome: "rejected" };
		});
}
