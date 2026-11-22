import { defineToolApi } from "../../worker/tool-api.ts";

export default defineToolApi(async (request, { path, db }) => {
	if (request.method === "GET" && path === "/time") {
		const now = await db(async (client) => {
			const result = await client.query<{ now: Date }>("select now() as now");
			return result.rows[0]?.now;
		});
		return Response.json({ now });
	}
	return Response.json({ error: "Not found" }, { status: 404 });
});
