import { expect, test } from "bun:test";
import { BOTS, type BotName, outOfScope } from "../../worker/access.ts";
import type { Database } from "../../worker/db.ts";
import { dayClosedSummary } from "../nutrition/store.ts";
import { MACROS, type DayView } from "../nutrition/types.ts";
import type { WorkoutLog } from "../workouts/log.ts";
import { dayClosedData, sessionFinishedData } from "./events.ts";
import { queueNotice, Refused } from "./notices.ts";
import { LIAISON_RECEIVER_CHARS, liaisonEnvelope, liaisonWire, type LiaisonEvent } from "./webhook.ts";

const DELIVERY_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const WIDEST_NUMBER = -1.2345678901234567e-300;
const HUGE = 50_000;
const NASTY_TEXTS = ["\u0000".repeat(HUGE), "😀".repeat(HUGE), '"\\'.repeat(HUGE), "x".repeat(HUGE)];

function sent(event: LiaisonEvent): string {
	return JSON.stringify(liaisonWire(liaisonEnvelope(event, DELIVERY_ID)));
}

function expectFits(event: LiaisonEvent): void {
	const body = sent(event);
	expect(body.length).toBeLessThanOrEqual(LIAISON_RECEIVER_CHARS);
	expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(LIAISON_RECEIVER_CHARS);
}

function widestDay(): DayView {
	const range = { min: WIDEST_NUMBER, max: WIDEST_NUMBER };
	const entry = { id: WIDEST_NUMBER, food: NASTY_TEXTS[0] ?? "", qty: WIDEST_NUMBER, unit: "", kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: null, sourceKind: "estimate" as const, sourceRef: null, sourceLabel: "", source: "", clientKey: "", loggedAt: null };
	return {
		date: "2099-12-31",
		closed: true,
		closedAt: new Date(8.64e15).toISOString(),
		estimated: true,
		partial: false,
		partialMark: null,
		partialReason: null,
		phase: NASTY_TEXTS[0] ?? "",
		entries: Array.from({ length: 10_000 }, () => entry),
		totals: { kcal: WIDEST_NUMBER, protein_g: WIDEST_NUMBER, carbs_g: WIDEST_NUMBER, fat_g: WIDEST_NUMBER, fiber_g: WIDEST_NUMBER },
		targets: { kcal: range, protein_g: range, carbs_g: range, fat_g: range, effectiveFrom: "2099-12-31", notes: NASTY_TEXTS[0] ?? "", stepsTarget: WIDEST_NUMBER },
		progress: Object.fromEntries(MACROS.map((macro) => [macro, { ...range, total: WIDEST_NUMBER, status: "under" as const }])) as DayView["progress"],
		checkIn: { bodyweightLb: WIDEST_NUMBER, steps: WIDEST_NUMBER, bloatScore: WIDEST_NUMBER, energy: WIDEST_NUMBER, sleep: WIDEST_NUMBER, stress: WIDEST_NUMBER, notes: NASTY_TEXTS[0] ?? "" },
	};
}

function widestLog(text: string): WorkoutLog {
	const set = { type: "working", weight: WIDEST_NUMBER, unit: "lb", reps: WIDEST_NUMBER, notes: text };
	return {
		$schema: "https://openweight.org/schemas/workout-log.schema.json",
		date: text,
		name: text,
		notes: text,
		blockId: text,
		weekId: text,
		dayId: text,
		status: "completed",
		kind: "lift",
		test: true,
		exercises: Array.from({ length: 1_000 }, (_, order) => ({ order, id: text, status: "completed" as const, exercise: { name: text }, prescribed: { targetLoad: text }, notes: text, sets: Array.from({ length: 100 }, () => set) })),
	};
}

const unreachable: Database = {
	query: async () => ({ rows: [], rowCount: 0 }),
} as unknown as Database;

const worstCase = {
	"day.closed": () => {
		expectFits({ app: "nutrition", event: "day.closed", ref: "2099-12-31", test: true, data: dayClosedData(dayClosedSummary(widestDay(), new Date(8.64e15).toISOString())) });
	},
	"session.finished": () => {
		for (const text of NASTY_TEXTS) expectFits({ app: "workouts", event: "session.finished", ref: DELIVERY_ID, test: true, data: sessionFinishedData(DELIVERY_ID, widestLog(text)) });
	},
	notice: async () => {
		const refused = await queueNotice(unreachable, { for: "all", label: "action needed", subject: "s".repeat(200), body: "x".repeat(64_000), refs: [], test: true }).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(Refused);
		expect((refused as Refused).status).toBe(413);
	},
} satisfies Record<LiaisonEvent["event"], () => void | Promise<void>>;

for (const [event, check] of Object.entries(worstCase)) {
	test(`no ${event} the liaison is sent can exceed ${LIAISON_RECEIVER_CHARS} characters`, check);
}

test("a session the old shape could not fit still fits, and points at the full log", () => {
	const log = widestLog("Leg Press");
	const data = sessionFinishedData(DELIVERY_ID, log);
	expect(JSON.stringify({ app: "workouts", event: "session.finished", deliveryId: DELIVERY_ID, data: { sessionId: DELIVERY_ID, log } }).length).toBeGreaterThan(LIAISON_RECEIVER_CHARS);
	expect(data).toMatchObject({ exercises: { total: 1_000, completed: 1_000, skipped: 0 }, sets: 100_000, full: { method: "GET", path: `/api/tools/workouts/sessions/${DELIVERY_ID}` } });
});

test("clipped text keeps whole characters and ends in an ellipsis", () => {
	const { name } = sessionFinishedData(DELIVERY_ID, widestLog("😀".repeat(HUGE)));
	expect(Array.from(name)).toHaveLength(80);
	expect(name.endsWith("😀…")).toBe(true);
	expect(sessionFinishedData(DELIVERY_ID, widestLog("W5 Legs")).name).toBe("W5 Legs");
});

test("full is readable only by the owning bot and the smoke identity", () => {
	const reach = (tool: string, route: string) => (Object.keys(BOTS) as BotName[]).filter((bot) => outOfScope({ kind: "bot", bot }, tool, route) === null);
	expect(reach("nutrition", "GET /day")).toEqual(["nutrition", "smoke"]);
	expect(reach("workouts", `GET /sessions/${DELIVERY_ID}`)).toEqual(["coach", "smoke"]);
	expect(Object.keys(BOTS)).not.toContain("liaison");
});
