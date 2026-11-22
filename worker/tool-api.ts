import type { WithDb } from "./db.ts";

export type ToolApiContext = {
	env: Env;
	ctx: ExecutionContext;
	path: string;
	db: WithDb;
};

export type ToolApi = (request: Request, context: ToolApiContext) => Response | Promise<Response>;

export function defineToolApi(handler: ToolApi): ToolApi {
	return handler;
}
