import { expect, test } from "bun:test";
import { addDays } from "./dates.ts";
import { type BodyComp, type ExpenditureInputs, estimateExpenditure, type IntakeDay, type LoggedSession, type WatchWorkout, type WeighIn } from "./expenditure.ts";

const PROFILE = { birthDate: "1990-03-14", heightM: 1.75 };

function series(from: string, count: number, at: (index: number) => number): { date: string; value: number }[] {
	return Array.from({ length: count }, (_, index) => ({ date: addDays(from, index), value: at(index) }));
}

function weighIns(from: string, count: number, lb = 180, perDay = 0): WeighIn[] {
	return series(from, count, (index) => lb + perDay * index).map(({ date, value }) => ({ date, lb: value }));
}

function intake(from: string, count: number, kcal: number): IntakeDay[] {
	return series(from, count, () => kcal).map(({ date, value }) => ({ date, kcal: value }));
}

function inputs(overrides: Partial<ExpenditureInputs> = {}): ExpenditureInputs {
	return {
		profile: PROFILE,
		weighIns: weighIns("2026-09-01", 60),
		intake: [],
		tracker: [],
		steps: series("2026-09-01", 60, () => 10000).map(({ date, value }) => ({ date, steps: value })),
		bodyComp: [],
		workouts: [],
		sessions: [],
		...overrides,
	};
}

function day(result: ReturnType<typeof estimateExpenditure>, date: string) {
	const found = result.days.find((item) => item.date === date);
	if (found === undefined) throw new Error(`no estimate for ${date}`);
	return found;
}

const watch = (overrides: Partial<WatchWorkout>): WatchWorkout => ({ date: "2026-10-20", category: 16, activity: "other", durationS: 1800, activeKcal: null, steps: null, hrAvg: null, ...overrides });
const lift = (overrides: Partial<LoggedSession> = {}): LoggedSession => ({ date: "2026-10-20", kind: "lift", name: "Squat day", modality: null, workingSets: 20, km: null, durationS: null, ...overrides });

test("with no calibration windows the estimate rests on the prior scale", () => {
	const result = estimateExpenditure(inputs(), "2026-10-01", "2026-10-28");
	expect(result.basis).toBe("estimated");
	expect(result.scale).toEqual({ value: 1, sd: 0.1, windows: [] });
	expect(result.days).toHaveLength(28);
	const first = day(result, "2026-10-01");
	expect(first.bmrMethod).toBe("mifflin");
	expect(first.bmr).toBe(Math.round(10 * (180 / 2.20462) + 6.25 * 175 - 5 * 36 + 5));
	expect(first.living).toBe(Math.round(first.bmr * 0.15));
	expect(first.tef).toBe(Math.round((first.total - first.tef) / 9));
	expect(result.tdee).not.toBeNull();
	expect(result.plusMinus).toBeGreaterThan(150);
	expect(result.measured).toBeNull();
});

test("age follows the profile birth date", () => {
	const birthday = inputs({ weighIns: weighIns("2026-03-01", 30) });
	const before = day(estimateExpenditure(birthday, "2026-03-13", "2026-03-13"), "2026-03-13");
	const after = day(estimateExpenditure(birthday, "2026-03-14", "2026-03-14"), "2026-03-14");
	expect(before.bmr - after.bmr).toBe(5);
});

test("a tracker run pulls the scale toward the tracker's number", () => {
	const plain = estimateExpenditure(inputs(), "2026-10-06", "2026-10-13");
	const tracker = series("2026-10-06", 8, () => 3300).map(({ date, value }) => ({ date, kcal: value }));
	const seeded = estimateExpenditure(inputs({ tracker }), "2026-10-06", "2026-10-13");
	expect(seeded.basis).toBe("calibrated");
	expect(seeded.scale.windows).toEqual([{ kind: "tracker", from: "2026-10-06", to: "2026-10-13", days: 8, tdee: 3300, plusMinus: 100 }]);
	expect(seeded.scale.value).toBeGreaterThan(1);
	expect(seeded.tdee as number).toBeGreaterThan(plain.tdee as number);
	expect(seeded.plusMinus as number).toBeLessThan(plain.plusMinus as number);
});

test("logged windows calibrate from intake and the weight slope, and short ones don't count", () => {
	const losing = inputs({ weighIns: weighIns("2026-09-01", 60, 185, -0.1), intake: intake("2026-10-01", 14, 2200) });
	const result = estimateExpenditure(losing, "2026-10-01", "2026-10-14");
	const window = result.scale.windows[0];
	expect(window?.kind).toBe("logged");
	expect(window?.tdee).toBe(2550);
	expect(result.basis).toBe("calibrated");
	expect(estimateExpenditure(inputs({ intake: intake("2026-10-01", 6, 2200) }), "2026-10-01", "2026-10-14").basis).toBe("estimated");
});

test("measured TDEE needs 14 logged days with weigh-ins at both ends", () => {
	const losing = { weighIns: weighIns("2026-09-01", 60, 185, -0.1), intake: intake("2026-10-01", 14, 2200) };
	expect(estimateExpenditure(inputs(losing), "2026-10-01", "2026-10-14").measured).toEqual({ tdee: 2550, plusMinus: 220, loggedDays: 14, from: "2026-10-01", to: "2026-10-14" });
	expect(estimateExpenditure(inputs({ ...losing, intake: intake("2026-10-01", 13, 2200) }), "2026-10-01", "2026-10-14").measured).toBeNull();
	const gap = losing.weighIns.filter((point) => point.date > "2026-10-03");
	expect(estimateExpenditure(inputs({ ...losing, weighIns: gap }), "2026-10-01", "2026-10-14").measured).toBeNull();
});

test("logged intake sets the thermic effect on that day", () => {
	const result = estimateExpenditure(inputs({ intake: [{ date: "2026-10-05", kcal: 3000 }] }), "2026-10-05", "2026-10-06");
	expect(day(result, "2026-10-05")).toMatchObject({ tef: 300, intake: 3000 });
	expect(day(result, "2026-10-06").intake).toBeNull();
});

test("days without a recent weigh-in get no estimate", () => {
	const result = estimateExpenditure(inputs({ weighIns: weighIns("2026-09-01", 10) }), "2026-09-20", "2026-09-30");
	expect(result.days.map((item) => item.date)).toEqual(["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"]);
	expect(estimateExpenditure(inputs({ weighIns: [] }), "2026-10-01", "2026-10-07")).toMatchObject({ tdee: null, plusMinus: null, components: null, days: [] });
});

test("unworn and missing step days use the trailing median and widen the margin", () => {
	const steps = [...inputs().steps.filter((item) => item.date !== "2026-10-10" && item.date !== "2026-10-11"), { date: "2026-10-10", steps: 400 }];
	const worn = estimateExpenditure(inputs(), "2026-10-01", "2026-10-14");
	const result = estimateExpenditure(inputs({ steps }), "2026-10-01", "2026-10-14");
	expect(day(result, "2026-10-10")).toMatchObject({ stepCount: null, stepsEstimated: true, steps: day(worn, "2026-10-10").steps });
	expect(day(result, "2026-10-11").stepsEstimated).toBe(true);
	expect(day(result, "2026-10-12")).toMatchObject({ stepCount: 10000, stepsEstimated: false });
	expect(result.plusMinus as number).toBeGreaterThanOrEqual(worn.plusMinus as number);
});

test("walks add nothing on top of steps and runs add only their excess", () => {
	const base = day(estimateExpenditure(inputs(), "2026-10-20", "2026-10-20"), "2026-10-20");
	const walk = day(estimateExpenditure(inputs({ workouts: [watch({ category: 1, activity: "walk", activeKcal: 250, steps: 6000 })] }), "2026-10-20", "2026-10-20"), "2026-10-20");
	expect(walk.training).toBe(0);
	expect(walk.total).toBe(base.total);
	const run = day(estimateExpenditure(inputs({ workouts: [watch({ category: 2, activity: "run", activeKcal: 500, steps: 5000 })] }), "2026-10-20", "2026-10-20"), "2026-10-20");
	expect(run.sessions).toEqual([{ name: "run", kcal: Math.round(500 - 5000 * 0.000576 * (180 / 2.20462)), source: "watch" }]);
});

test("workouts over four hours are dropped", () => {
	const result = day(estimateExpenditure(inputs({ workouts: [watch({ category: 6, activity: "bike", activeKcal: 900, durationS: 5 * 3600 })] }), "2026-10-20", "2026-10-20"), "2026-10-20");
	expect(result.sessions).toEqual([]);
});

test("a lift day counts the larger of the lift and the watch's non-step workouts, not both", () => {
	const lifted = day(estimateExpenditure(inputs({ sessions: [lift()] }), "2026-10-20", "2026-10-20"), "2026-10-20");
	expect(lifted.sessions).toEqual([{ name: "Squat day", kcal: Math.round(20 * 0.12 * (180 / 2.20462)), source: "estimate" }]);
	const stretch = watch({ category: 552, activity: "stretching", activeKcal: 60 });
	expect(day(estimateExpenditure(inputs({ sessions: [lift()], workouts: [stretch] }), "2026-10-20", "2026-10-20"), "2026-10-20").sessions).toEqual(lifted.sessions);
	const weights = watch({ category: 16, activity: "weights", activeKcal: 400 });
	expect(day(estimateExpenditure(inputs({ sessions: [lift()], workouts: [weights] }), "2026-10-20", "2026-10-20"), "2026-10-20").sessions).toEqual([{ name: "weights", kcal: 400, source: "watch" }]);
});

test("logged conditioning is skipped when the watch recorded cardio that day", () => {
	const tempo = lift({ kind: "conditioning", name: "Tempo run", workingSets: 0, km: 8 });
	const logged = day(estimateExpenditure(inputs({ sessions: [tempo] }), "2026-10-20", "2026-10-20"), "2026-10-20");
	expect(logged.sessions).toEqual([{ name: "Tempo run", kcal: Math.round(8 * 0.4 * (180 / 2.20462)), source: "estimate" }]);
	const both = day(estimateExpenditure(inputs({ sessions: [tempo], workouts: [watch({ category: 2, activity: "run", activeKcal: 600, steps: 8000 })] }), "2026-10-20", "2026-10-20"), "2026-10-20");
	expect(both.sessions.map((item) => item.name)).toEqual(["run"]);
});

test("heart rate stands in when a workout has no calories", () => {
	const result = day(estimateExpenditure(inputs({ workouts: [watch({ category: 6, activity: "bike", hrAvg: 140, durationS: 3600 })] }), "2026-10-20", "2026-10-20"), "2026-10-20");
	expect(result.sessions[0]?.source).toBe("heart rate");
	expect(result.sessions[0]?.kcal).toBeGreaterThan(300);
});

test("fat-free mass sets BMR only with three fresh readings in the current series", () => {
	const reading = (date: string, fatPct: number): BodyComp => ({ date, ffmKg: 70, fatPct });
	const old = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"].map((date) => reading(date, 18));
	const recent = ["2026-10-10", "2026-10-12", "2026-10-14"];
	const katch = day(estimateExpenditure(inputs({ bodyComp: [...old, ...recent.map((date) => reading(date, 17))] }), "2026-10-20", "2026-10-20"), "2026-10-20");
	expect(katch).toMatchObject({ bmrMethod: "katch-mcardle", bmr: Math.round(370 + 21.6 * 70) });
	const stale = day(estimateExpenditure(inputs({ bodyComp: old }), "2026-10-20", "2026-10-20"), "2026-10-20");
	expect(stale.bmrMethod).toBe("mifflin");
	const broke = [...old, ...recent.slice(0, 2).map((date) => reading(date, 17)), reading("2026-10-16", 10), reading("2026-10-17", 10)];
	expect(day(estimateExpenditure(inputs({ bodyComp: broke }), "2026-10-20", "2026-10-20"), "2026-10-20").bmrMethod).toBe("mifflin");
	const fresh = [...broke, reading("2026-10-18", 10)];
	expect(day(estimateExpenditure(inputs({ bodyComp: fresh }), "2026-10-20", "2026-10-20"), "2026-10-20").bmrMethod).toBe("katch-mcardle");
});

test("a week with logged intake and a tracker export calibrates near the tracker", () => {
	const logged = [2600, 2750, 2550, 2800, 2600, 2750, 2900, 2800];
	const lbs = [178.6, 179.3, 179.8, 178.7, 179.4, 179.1, 179.2, 179.5];
	const steps = [11500, 14000, 15500, 17000, 15000, 18500, 24000, 10500];
	const dates = logged.map((_, index) => addDays("2026-10-06", index));
	const result = estimateExpenditure(
		inputs({
			weighIns: [...weighIns("2026-09-15", 21, 178.8), ...dates.map((date, index) => ({ date, lb: lbs[index] as number }))],
			intake: dates.map((date, index) => ({ date, kcal: logged[index] as number })),
			tracker: dates.map((date) => ({ date, kcal: 2870 })),
			steps: dates.map((date, index) => ({ date, steps: steps[index] as number })),
			sessions: [lift({ date: "2026-10-07", workingSets: 16 }), lift({ date: "2026-10-12", workingSets: 16 }), lift({ date: "2026-10-13", workingSets: 16 })],
			workouts: [watch({ date: "2026-10-08", category: 2, activity: "run", activeKcal: 520, steps: 5600 })],
		}),
		"2026-10-06",
		"2026-10-13",
	);
	expect(result.basis).toBe("calibrated");
	expect(result.scale.windows.map((window) => window.kind)).toEqual(["logged", "tracker"]);
	expect(Math.abs((result.tdee as number) - 2870)).toBeLessThan(60);
	expect(result.plusMinus as number).toBeLessThanOrEqual(110);
});
