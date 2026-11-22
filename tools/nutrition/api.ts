import { z } from "zod";
import { defineToolApi } from "../../worker/tool-api.ts";
import { deliverSoon } from "../../worker/webhooks.ts";
import { nutritionMcp } from "./bot.ts";
import { addDays, today } from "./dates.ts";
import { foodChanges, isoDate } from "./schemas.ts";
import { changeFood, closeDayFromUi, getDay, getExpenditure, getHistory, getPhase, getSteps, getWeights, Rejected, updateDay } from "./store.ts";
import liaison from "../liaison/webhook.ts";
import webhook from "./webhook.ts";

const dated = z.strictObject({ date: isoDate });

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
				const { date, test } = await body(request, dated.extend({ test: z.boolean().optional() }));
				const { day, deliveryId } = await db((client) => closeDayFromUi(client, date, test === true));
				if (deliveryId !== null) {
					deliverSoon(ctx, env, webhook, [deliveryId]);
					deliverSoon(ctx, env, liaison, [deliveryId]);
				}
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
			case "GET /expenditure": {
				const to = url.searchParams.get("to") ?? today();
				const from = url.searchParams.get("from") ?? addDays(to, -89);
				if (!isoDate.safeParse(from).success || !isoDate.safeParse(to).success || from > to) throw new Rejected("Use dates like 2026-11-22, from before to");
				return Response.json(await db((client) => getExpenditure(client, from, to)));
			}
			case "GET /steps":
				return Response.json(await db(getSteps));
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
