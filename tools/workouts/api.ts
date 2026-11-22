import { withRequestDb } from "../../worker/db.ts";
import { defineToolApi } from "../../worker/tool-api.ts";
import { deliverDue } from "../../worker/webhooks.ts";
import { readTrainingLog, TrainingLogError } from "./github.ts";
import { buildLog, checkLog } from "./log.ts";
import { buildSchedule, findDay, pacificToday } from "./schedule.ts";
import { createSession, deleteOpenSession, deleteSet, finishSession, getSession, listSessions, putSet, requeue, sessionRow, updateExercise, updateSessionNotes, type SetInput } from "./store.ts";
import webhook from "./webhook.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION = new RegExp(`^/sessions/(${UUID})$`);
const ACTION = new RegExp(`^/sessions/(${UUID})/(finish|redeliver)$`);
const EXERCISE = new RegExp(`^/sessions/(${UUID})/exercises/(\\d+)$`);
const SET = new RegExp(`^/sessions/(${UUID})/sets/(\\d+)/(\\d+)$`);
const NOTE_LIMIT = 2000;

class BadRequest extends Error {}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function body(request: Request): Promise<Record<string, unknown>> {
	const parsed: unknown = await request.json().catch(() => null);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BadRequest("Body must be a JSON object");
	return parsed as Record<string, unknown>;
}

function optionalNumber(value: unknown, field: string, { integer, max }: { integer: boolean; max: number }): number | null {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) throw new BadRequest(`${field} must be a number from 0 to ${max}`);
	if (integer && !Number.isInteger(value)) throw new BadRequest(`${field} must be a whole number${field === "rir" ? "; put half RIR in notes" : ""}`);
	return value;
}

function optionalNote(value: unknown, field: string): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || value.length > NOTE_LIMIT) throw new BadRequest(`${field} must be text up to ${NOTE_LIMIT} characters`);
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

export function parseSet(input: Record<string, unknown>): SetInput {
	const weight = optionalNumber(input.weight, "weight", { integer: false, max: 2000 });
	const unit = input.unit === "lb" || input.unit === "kg" ? input.unit : null;
	if (weight !== null && unit === null) throw new BadRequest("weight needs a unit of lb or kg");
	return {
		weight,
		unit: weight === null ? null : unit,
		reps: optionalNumber(input.reps, "reps", { integer: true, max: 1000 }),
		rir: optionalNumber(input.rir, "rir", { integer: true, max: 10 }),
		asWritten: input.asWritten === true,
		notes: optionalNote(input.notes, "notes"),
	};
}

function trainingLogError(error: unknown): Response {
	if (!(error instanceof TrainingLogError)) throw error;
	const code = error.status === null && error.message.includes("TRAINING_LOG_TOKEN") ? "missing_token" : error.status === 401 || error.status === 403 || error.status === 404 ? "no_access" : "github";
	return json({ error: error.message, code }, 502);
}

export default defineToolApi(async (request, { env, ctx, path, db }) => {
	const method = request.method;
	try {
		if (method === "GET" && path === "/program") {
			const today = pacificToday();
			const [{ program, repoSessions }, sessions] = await Promise.all([readTrainingLog(env, today), db((client) => listSessions(client, 200))]);
			return json({ schedule: buildSchedule(program, repoSessions, sessions, today), webhookReady: webhook.target(env) !== null });
		}

		if (method === "GET" && path === "/sessions") return json({ sessions: await db((client) => listSessions(client)) });

		if (method === "POST" && path === "/sessions") {
			const input = await body(request);
			const weekId = typeof input.weekId === "string" ? input.weekId : null;
			const dayId = typeof input.dayId === "string" ? input.dayId : null;
			if (weekId === null || dayId === null) throw new BadRequest("weekId and dayId are required");
			const today = pacificToday();
			const { program } = await readTrainingLog(env, today);
			const day = findDay(program, weekId, dayId);
			if (day === null) return json({ error: `${weekId} ${dayId} is not in ${program.id}` }, 404);
			const id = await db((client) => createSession(client, program.id, day, today, input.test === true));
			return json({ session: await db((client) => getSession(client, id)) }, 201);
		}

		const session = SESSION.exec(path);
		if (session !== null) {
			const [, id = ""] = session;
			if (method === "GET") {
				const found = await db((client) => getSession(client, id));
				return found === null ? json({ error: "Session not found" }, 404) : json({ session: found });
			}
			if (method === "PATCH") {
				const input = await body(request);
				await db((client) => updateSessionNotes(client, id, optionalNote(input.notes, "notes")));
				return json({ session: await db((client) => getSession(client, id)) });
			}
			if (method === "DELETE") {
				const deleted = await db((client) => deleteOpenSession(client, id));
				return deleted ? json({ ok: true }) : json({ error: "Only open or test sessions can be deleted" }, 409);
			}
		}

		const set = SET.exec(path);
		if (set !== null) {
			const [, id = "", position = "0", index = "0"] = set;
			const open = await db((client) => getSession(client, id));
			if (open === null) return json({ error: "Session not found" }, 404);
			if (open.status !== "open") return json({ error: "This session is finished" }, 409);
			if (!open.exercises.some((exercise) => exercise.position === Number(position))) return json({ error: "Exercise not found" }, 404);
			if (method === "PUT") {
				const input = parseSet(await body(request));
				await db((client) => putSet(client, id, Number(position), Number(index), input));
				return json({ ok: true });
			}
			if (method === "DELETE") {
				await db((client) => deleteSet(client, id, Number(position), Number(index)));
				return json({ ok: true });
			}
		}

		const exercise = EXERCISE.exec(path);
		if (exercise !== null && method === "PATCH") {
			const [, id = "", position = "0"] = exercise;
			const input = await body(request);
			const status = input.status === "planned" || input.status === "completed" || input.status === "skipped" ? input.status : undefined;
			if (input.status !== undefined && status === undefined) throw new BadRequest("status must be planned, completed or skipped");
			await db((client) => updateExercise(client, id, Number(position), { ...(status === undefined ? {} : { status }), ...("notes" in input ? { notes: optionalNote(input.notes, "notes") } : {}) }));
			return json({ session: await db((client) => getSession(client, id)) });
		}

		const action = ACTION.exec(path);
		if (action !== null && method === "POST") {
			const [, id = "", verb] = action;
			const found = await db((client) => getSession(client, id));
			if (found === null) return json({ error: "Session not found" }, 404);
			let deliveryId: string | null;
			if (verb === "finish") {
				const log = buildLog(sessionRow(found));
				const problems = checkLog(log);
				if (problems.length > 0) return json({ error: "The log is not valid", problems }, 422);
				deliveryId = await db((client) => finishSession(client, id, (delivery) => ({ event: "session.finished", deliveryId: delivery, sessionId: id, ...(found.test ? { test: true } : {}), log })));
			} else {
				deliveryId = await db((client) => requeue(client, id));
				if (deliveryId === null) return json({ error: "This session has no delivery" }, 409);
			}
			const first = deliveryId;
			ctx.waitUntil(withRequestDb(env.DB, ctx, (fresh) => deliverDue(fresh, webhook, env, [first])).catch((error: unknown) => console.error("Coach webhook delivery failed", error)));
			return json({ session: await db((client) => getSession(client, id)) });
		}

		return json({ error: "Not found" }, 404);
	} catch (error) {
		if (error instanceof BadRequest) return json({ error: error.message }, 400);
		if (error instanceof TrainingLogError) return trainingLogError(error);
		throw error;
	}
});
