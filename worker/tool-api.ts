import type { Caller } from "./access.ts";
import type { WithDb } from "./db.ts";

export type ToolApiContext = {
	env: Env;
	ctx: ExecutionContext;
	path: string;
	db: WithDb;
	caller: Caller;
};

export type ToolApi = (request: Request, context: ToolApiContext) => Response | Promise<Response>;

export function defineToolApi(handler: ToolApi): ToolApi {
	return handler;
}

export type ToolCronContext = {
	env: Env;
	ctx: ExecutionContext;
	db: WithDb;
};

export type ToolCron = (context: ToolCronContext) => Promise<void>;

export function defineToolCron(handler: ToolCron): ToolCron {
	return handler;
}
