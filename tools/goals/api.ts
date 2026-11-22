import { z } from "zod";
import { defineToolApi } from "../../worker/tool-api.ts";
import { goalsMcp } from "./bot.ts";
import { pageCheckin } from "./schemas.ts";
import { addCheckin, getOverview, Rejected } from "./store.ts";

async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
	const parsed = schema.safeParse(await request.json().catch(() => undefined));
	if (!parsed.success) throw new Rejected(z.prettifyError(parsed.error));
	return parsed.data;
}

export default defineToolApi(async (request, context) => {
	const { path, db, access } = context;
	if (path === "/mcp") return goalsMcp(request, context);
	if (access.kind === "serviceToken") return Response.json({ error: "Forbidden: the goals page routes are for Matt" }, { status: 403 });
	try {
		switch (`${request.method} ${path}`) {
			case "GET /overview":
				return Response.json(await db(getOverview), { headers: { "cache-control": "no-store" } });
			case "POST /checkins": {
				const checkin = await body(request, pageCheckin);
				return Response.json(await db((client) => addCheckin(client, checkin, "matt")));
			}
			default:
				return Response.json({ error: "Not found" }, { status: 404 });
		}
	} catch (error) {
		if (error instanceof Rejected) return Response.json({ error: error.message }, { status: 409 });
		throw error;
	}
});
