import { expect, test } from "bun:test";
import type { SleepStage } from "./apple-health.ts";
import type { HealthDay } from "./health.ts";
import { buildNights, type Segment, type WithingsNight, withNights } from "./nights.ts";

const PST = -480;
const at = (iso: string) => Date.parse(iso);
const segment = (source: string, stage: SleepStage, start: string, end: string): Segment => ({ source, stage, start: at(start), end: at(end), offsetMin: PST });

const withingsNight = (start: string, end: string): WithingsNight => ({
	start: at(start),
	end: at(end),
	timezone: "America/Los_Angeles",
	asleepS: 25_200,
	inBedS: 27_000,
	lightS: 15_000,
	deepS: 5000,
	remS: 5200,
	awakeS: 1200,
	hrMin: 54,
	rrAvg: 15,
});

test("a night away from the Eight Sleep falls back to Withings, in the night's own time zone", () => {
	const [night] = buildNights([], [], [withingsNight("2026-11-22T07:10:00Z", "2026-11-22T14:40:00Z")]);
	expect(night).toMatchObject({ date: "2026-11-22", source: "Withings", bedtime: "23:10", wake: "06:40", asleepS: 25_200, restingHr: 54, respiratoryRate: 15, timeline: [], alsoFrom: [] });
});

test("Eight Sleep beats the watch, and both beat Withings, on the same night", () => {
	const nights = buildNights(
		[segment("Matt’s Apple Watch", "core", "2026-11-21T07:00:00Z", "2026-11-21T15:00:00Z"), segment("Eight Sleep", "core", "2026-11-21T07:30:00Z", "2026-11-21T14:00:00Z")],
		[],
		[withingsNight("2026-11-21T07:00:00Z", "2026-11-21T14:30:00Z")],
	);
	expect(nights.map(({ date, source, alsoFrom }) => ({ date, source, alsoFrom }))).toEqual([{ date: "2026-11-21", source: "Eight Sleep", alsoFrom: ["Matt’s Apple Watch", "Withings"] }]);
});

test("a wake in the middle of the night stays one night, and an afternoon nap does not replace it", () => {
	const nights = buildNights(
		[
			segment("Matt’s Apple Watch", "core", "2026-11-21T07:00:00Z", "2026-11-21T10:00:00Z"),
			segment("Matt’s Apple Watch", "core", "2026-11-21T11:30:00Z", "2026-11-21T14:00:00Z"),
			segment("Matt’s Apple Watch", "core", "2026-11-21T22:00:00Z", "2026-11-21T22:40:00Z"),
		],
		[],
		[],
	);
	expect(nights).toHaveLength(1);
	expect(nights[0]).toMatchObject({ bedtime: "23:00", wake: "06:00", asleepS: 5.5 * 3600, inBedS: 7 * 3600 });
});

test("a source without stages reports only time asleep", () => {
	const [night] = buildNights([segment("Sleep app", "asleep", "2026-11-21T07:00:00Z", "2026-11-21T14:00:00Z")], [], []);
	expect(night).toMatchObject({ asleepS: 7 * 3600, lightS: null, deepS: null, remS: null, timeline: [{ stage: "asleep", startS: 0, endS: 7 * 3600 }] });
});

test("vitals prefer the night's own source and fall back to any other", () => {
	const nights = buildNights(
		[segment("Eight Sleep", "deep", "2026-11-21T07:00:00Z", "2026-11-21T14:00:00Z")],
		[
			{ metric: "heart_rate_variability", source: "Matt’s Apple Watch", at: at("2026-11-21T10:00:00Z"), offsetMin: PST, value: 40 },
			{ metric: "heart_rate_variability", source: "Eight Sleep", at: at("2026-11-21T14:00:00Z"), offsetMin: PST, value: 61 },
			{ metric: "heart_rate_variability", source: "Eight Sleep", at: at("2026-11-21T20:00:00Z"), offsetMin: PST, value: 99 },
			{ metric: "respiratory_rate", source: "Matt’s Apple Watch", at: at("2026-11-21T12:00:00Z"), offsetMin: PST, value: 13.26 },
			{ metric: "resting_heart_rate", source: "Matt’s Apple Watch", at: at("2026-11-21T07:30:00Z"), offsetMin: PST, value: 70 },
			{ metric: "resting_heart_rate", source: "Matt’s Apple Watch", at: at("2026-11-21T15:00:00Z"), offsetMin: PST, value: 51 },
		],
		[],
	);
	expect(nights[0]).toMatchObject({ hrv: 61, respiratoryRate: 13.3, restingHr: 51 });
});

test("a Withings night keeps its daily_health row, and an Apple night replaces the Withings sleep fields", () => {
	const day = (date: string, extra: Partial<HealthDay> = {}): HealthDay => ({
		date,
		steps: 8000,
		activeKcal: null,
		totalKcal: null,
		distanceM: null,
		dayHrAvg: null,
		dayHrMin: null,
		dayHrMax: null,
		restingHr: 47,
		sleeps: 2,
		sleepS: 25_200,
		sleepScore: 82,
		sleepHrAvg: 55,
		sleepRrAvg: 14,
		workouts: 0,
		workoutKcal: null,
		workoutS: null,
		...extra,
	});
	const nights = buildNights(
		[segment("Eight Sleep", "deep", "2026-11-21T07:00:00Z", "2026-11-21T14:00:00Z")],
		[{ metric: "respiratory_rate", source: "Eight Sleep", at: at("2026-11-21T10:00:00Z"), offsetMin: PST, value: 14.5 }],
		[withingsNight("2026-11-20T07:10:00Z", "2026-11-20T14:40:00Z")],
	);
	expect(withNights([day("2026-11-20"), day("2026-11-21")], nights)).toEqual([
		day("2026-11-20"),
		day("2026-11-21", { restingHr: 47, sleeps: 1, sleepS: 7 * 3600, sleepScore: null, sleepHrAvg: null, sleepRrAvg: 14.5 }),
	]);
});
