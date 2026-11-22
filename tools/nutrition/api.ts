import { z } from "zod";
import { defineToolApi } from "../../worker/tool-api.ts";
import { deliverSoon } from "../../worker/webhooks.ts";
import { nutritionMcp } from "./bot.ts";
import { today } from "./dates.ts";
import { foodChanges, isoDate } from "./schemas.ts";
import { changeFood, closeDayFromUi, getDay, getHistory, getPhase, getWeights, Rejected, updateDay } from "./store.ts";
import webhook from "./webhook.ts";

const dated = z.object({ date: isoDate });

async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
	const parsed = schema.safeParse(await request.json().catch(() => undefined));
	if (!parsed.success) throw new Rejected(z.prettifyError(parsed.error));
	return parsed.data;
}

export default defineToolApi(async (request, context) => {
	const { path, db, env, ctx } = context;
	const url = new URL(request.url);
	const route = `${request.method} ${path}`;
	try {
		switch (route) {
			case "POST /mcp":
			case "GET /mcp":
			case "DELETE /mcp":
				return nutritionMcp(request, context);
			case "GET /day": {
				const date = url.searchParams.get("date") ?? today();
				if (!isoDate.safeParse(date).success) throw new Rejected("Use a date like 2026-11-22");
				return Response.json(await db((client) => getDay(client, date)));
			}
			case "POST /day/food": {
				const { date, ...changes } = await body(request, foodChanges.extend({ date: isoDate }));
				return Response.json(await db((client) => changeFood(client, date, changes, "ui")));
			}
			case "POST /day/close": {
				const { date } = await body(request, dated);
				const { day, deliveryId } = await db((client) => closeDayFromUi(client, date));
				if (deliveryId !== null) deliverSoon(ctx, env, webhook, [deliveryId]);
				return Response.json(day);
			}
			case "POST /day/reopen": {
				const { date } = await body(request, dated);
				return Response.json(await db((client) => updateDay(client, date, { closed: false })));
			}
			case "GET /history":
				return Response.json(await db(getHistory));
			case "GET /weights":
				return Response.json(await db(getWeights));
			case "GET /phase":
				return Response.json(await db((client) => getPhase(client)));
			default:
				return Response.json({ error: "Not found" }, { status: 404 });
		}
	} catch (error) {
		if (error instanceof Rejected) return Response.json({ error: error.message }, { status: 409 });
		throw error;
	}
});
