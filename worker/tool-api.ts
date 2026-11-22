import type { Database } from "./db.ts";

export type ToolApiContext = {
	env: Env;
	ctx: ExecutionContext;
	path: string;
	db: <T>(work: (db: Database) => Promise<T>) => Promise<T>;
};

export type ToolApi = (request: Request, context: ToolApiContext) => Response | Promise<Response>;

export function defineToolApi(handler: ToolApi): ToolApi {
	return handler;
}
