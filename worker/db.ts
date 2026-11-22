import { Client } from "pg";

export type Database = Pick<Client, "query">;

export async function withDb<T>(env: Env, work: (db: Database) => Promise<T>): Promise<T> {
	const client = new Client({ connectionString: env.DB.connectionString });
	await client.connect();
	try {
		return await work(client);
	} finally {
		await client.end();
	}
}
