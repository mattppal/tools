import { Client } from "pg";

export type Database = Pick<Client, "query">;
export type WithDb = <T>(work: (db: Database) => Promise<T>) => Promise<T>;

const CONNECT_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 10_000;

export async function withRequestDb<T>(hyperdrive: Hyperdrive, ctx: ExecutionContext, handle: (withDb: WithDb) => Promise<T>): Promise<T> {
	const client = new Client({
		connectionString: hyperdrive.connectionString,
		connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
		query_timeout: QUERY_TIMEOUT_MS,
	});
	let connected: Promise<unknown> | undefined;
	try {
		return await handle(async (work) => {
			connected ??= client.connect();
			await connected;
			return work(client);
		});
	} finally {
		ctx.waitUntil(client.end());
	}
}
