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
		return transport.handleRequest(request);
	};
}
