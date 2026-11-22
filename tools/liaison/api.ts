import { z } from "zod";
import { requireBot } from "../../worker/bot-auth.ts";
import { defineToolApi } from "../../worker/tool-api.ts";
import { deliverDue } from "../../worker/webhooks.ts";
import { noticeRequest, queueNotice, Refused } from "./notices.ts";
import liaison, { liaisonWire } from "./webhook.ts";

const LIST_LIMIT = 50;

type DeliveryRow = {
	delivery_id: string;
	payload: unknown;
	attempts: number;
	delivered_at: Date | null;
	next_attempt_at: Date;
	last_status: number | null;
	last_error: string | null;
};

const COLUMNS = "delivery_id, payload, attempts, delivered_at, next_attempt_at, last_status, last_error";

function view(row: DeliveryRow) {
	return {
		deliveryId: row.delivery_id,
		delivered: row.delivered_at !== null,
		deliveredAt: row.delivered_at?.toISOString() ?? null,
		attempts: row.attempts,
		lastStatus: row.last_status,
		lastError: row.last_error,
		nextAttemptAt: row.delivered_at === null ? row.next_attempt_at.toISOString() : null,
		sent: liaisonWire(row.payload),
	};
}

const listQuery = z.strictObject({
	app: z.enum(["nutrition", "workouts", "tools"]).optional(),
	thread: z.uuid().optional(),
});

export default defineToolApi(async (request, context) => {
	const { env, db, path } = context;
	const caller = await requireBot(request, context, "liaison");
	if (caller instanceof Response) return caller;
	const route = `${request.method} ${path}`;
	try {
		switch (route) {
			case "POST /notices": {
				const parsed = noticeRequest.safeParse(await request.json().catch(() => undefined));
				if (!parsed.success) throw new Refused(400, z.prettifyError(parsed.error));
				const { noticeId, created } = await db((client) => queueNotice(client, parsed.data));
				await deliverDue(db, liaison, env, [noticeId]);
				const row = await db(async (client) => (await client.query<DeliveryRow>(`select ${COLUMNS} from liaison.deliveries where delivery_id = $1`, [noticeId])).rows[0]);
				if (row === undefined) throw new Error(`Notice ${noticeId} vanished after it was queued`);
				return Response.json(view(row), { status: created ? 201 : 200 });
			}
			case "GET /deliveries": {
				const parsed = listQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
				if (!parsed.success) throw new Refused(400, z.prettifyError(parsed.error));
				const { app, thread } = parsed.data;
				const { rows } = await db((client) =>
					client.query<DeliveryRow>(
						`select ${COLUMNS} from liaison.deliveries
						where ($1::text is null or app = $1) and ($2::text is null or (app = 'tools' and ref = $2))
						order by created_at desc limit ${LIST_LIMIT}`,
						[thread === undefined ? (app ?? null) : "tools", thread ?? null],
					),
				);
				return Response.json({ deliveries: rows.map(view) });
			}
			default:
				return Response.json({ error: "Not found" }, { status: 404 });
		}
	} catch (error) {
		if (error instanceof Refused) return Response.json({ error: error.message }, { status: error.status });
		throw error;
	}
});
