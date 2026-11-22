import type { WithDb } from "./db.ts";

export type DebugRow = { label: string; value: string };

export type ToolDebug = (context: { env: Env; db: WithDb }) => Promise<readonly DebugRow[]>;

export function defineToolDebug(debug: ToolDebug): ToolDebug {
	return debug;
}
