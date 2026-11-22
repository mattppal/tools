import { addDays, dayNumber, isoDate } from "./dates.ts";

export type Profile = { birthDate: string | null; heightM: number | null };
export type WeighIn = { date: string; lb: number };
export type IntakeDay = { date: string; kcal: number; source?: string };
export type TrackerDay = { date: string; kcal: number };
export type StepsDay = { date: string; steps: number | null; activeKcal?: number | null };
export type BodyComp = { date: string; ffmKg: number; fatPct: number };
export type WatchWorkout = { date: string; category: number; activity: string; durationS: number; activeKcal: number | null; steps: number | null; distanceM?: number | null; hrAvg: number | null };
export type LoggedSession = { date: string; kind: "lift" | "conditioning"; name: string; modality: string | null; workingSets: number; km: number | null; durationS: number | null };

export type ExpenditureInputs = {
	profile: Profile;
	weighIns: readonly WeighIn[];
	intake: readonly IntakeDay[];
	tracker: readonly TrackerDay[];
	steps: readonly StepsDay[];
	bodyComp: readonly BodyComp[];
	workouts: readonly WatchWorkout[];
	sessions: readonly LoggedSession[];
};

export type TrainingSource = "watch" | "heart rate" | "estimate";
export type TrainingItem = { name: string; kcal: number; source: TrainingSource };
export type BmrMethod = "katch-mcardle" | "mifflin";
export type StepsSource = "count" | "active energy" | "median";

export type DayEstimate = {
	date: string;
	total: number;
	bmr: number;
	bmrMethod: BmrMethod;
	living: number;
	steps: number;
	stepCount: number | null;
	stepsEstimated: boolean;
	stepsFrom: StepsSource;
	training: number;
	sessions: TrainingItem[];
	tef: number;
	intake: number | null;
	trendLb: number;
};

export type CalibrationWindow = { kind: "logged" | "tracker"; source: string; from: string; to: string; days: number; tdee: number; plusMinus: number; scale: number; weight: number };
export type Measured = { tdee: number; plusMinus: number; loggedDays: number; from: string; to: string };
export type Components = { bmr: number; living: number; steps: number; training: number; tef: number };

export type ExpenditureResult = {
	tdee: number | null;
	plusMinus: number | null;
	basis: "estimated" | "calibrated";
	loggedDays: number;
	measured: Measured | null;
	scale: { value: number; sd: number; windows: CalibrationWindow[] };
	components: Components | null;
	days: DayEstimate[];
};

const KCAL_PER_LB = 3500;
const LB_PER_KG = 2.20462;
const LIVING_SHARE = 0.15;
const STEP_KCAL_PER_KG = 0.000576;
const LIFT_KCAL_PER_KG_SET = 0.12;
const RUN_EXCESS_KCAL_PER_KG_KM = 0.4;
const RUN_STRIDE_M = 1.08;
const HIKE_STRIDE_M = 0.75;
const MIN_ACTIVE_KCAL = 150;
const DRIFT_PER_YEAR = 0.03;
const PARTIAL_OF_MEDIAN = 0.5;
const LOGGED_SOURCE = "logged";
const ASSUMED_RUN_KMH = 10;
const BIKE_NET_MET = 5;
const OTHER_NET_MET = 4;
const TEF_SHARE = 0.1;
const PRIOR_SD = 0.1;
const TRACKER_SD = 100;
const INTAKE_ERROR = 0.05;
const MIN_SLOPE_SIGMA_LB = 0.8;
const MAX_WORKOUT_S = 4 * 3600;
const MIN_WORN_STEPS = 1000;
const STEP_MEDIAN_DAYS = 28;
const IMPUTED_STEPS_SD = 150;
const TREND_DAYS = 21;
const TREND_MIN_FIT = 5;
const WEIGHT_LOOKBACK_DAYS = 14;
const FFM_DAYS = 28;
const FFM_MIN_READINGS = 3;
const FAT_BREAK_POINTS = 4;
const FAT_BREAK_HISTORY = 5;
const DEFAULT_HEIGHT_M = 1.75;
const DEFAULT_AGE = 35;
const MAX_WINDOW_DAYS = 28;
const CALIBRATION_MIN_DAYS = 7;
const CALIBRATION_MIN_WEIGH_INS = 5;
export const MEASURED_MIN_DAYS = 14;
const MEASURED_MIN_WEIGH_INS = 8;
const MEASURED_EDGE_DAYS = 3;
const MIN_COVERAGE = 0.8;

const WALKS = new Set([1, 306]);
const STEP_WORKOUTS = new Set([2, 3, 307]);
const HIKES = new Set([3]);
const CARDIO = new Set([2, 3, 6, 7, 18, 187, 307, 308]);

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const mean = (values: readonly number[]) => sum(values) / values.length;
const median = (values: readonly number[]) => {
	const sorted = values.toSorted((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};
const round10 = (value: number) => Math.round(value / 10) * 10;

function groupBy<T extends { date: string }>(items: readonly T[]): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) groups.set(item.date, [...(groups.get(item.date) ?? []), item]);
	return groups;
}

function fitLine(points: readonly { date: string; lb: number }[]) {
	const xs = points.map((point) => dayNumber(point.date));
	const mx = mean(xs);
	const my = mean(points.map((point) => point.lb));
	const sxx = sum(xs.map((x) => (x - mx) ** 2));
	const slope = sxx === 0 ? 0 : sum(points.map((point, index) => ((xs[index] as number) - mx) * (point.lb - my))) / sxx;
	const residuals = points.map((point, index) => point.lb - (my + slope * ((xs[index] as number) - mx)));
	const sigma = Math.max(Math.sqrt(sum(residuals.map((r) => r * r)) / Math.max(points.length - 2, 1)), MIN_SLOPE_SIGMA_LB);
	return { slope, slopeSe: sxx === 0 ? Number.POSITIVE_INFINITY : sigma / Math.sqrt(sxx), at: (date: string) => my + slope * (dayNumber(date) - mx) };
}

function between<T extends { date: string }>(sorted: readonly T[], from: string, to: string): T[] {
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((sorted[middle] as T).date < from) low = middle + 1;
		else high = middle;
	}
	const out: T[] = [];
	for (let index = low; index < sorted.length && (sorted[index] as T).date <= to; index++) out.push(sorted[index] as T);
	return out;
}

function ageOn(birthDate: string | null, date: string): number {
	if (birthDate === null) return DEFAULT_AGE;
	const years = Number(date.slice(0, 4)) - Number(birthDate.slice(0, 4));
	return date.slice(5) < birthDate.slice(5) ? years - 1 : years;
}

function bodyCompSeries(readings: readonly BodyComp[]): (BodyComp & { series: number })[] {
	const sorted = readings.toSorted((a, b) => a.date.localeCompare(b.date));
	let series = 0;
	let current: number[] = [];
	return sorted.map((reading) => {
		if (current.length > 0 && Math.abs(reading.fatPct - median(current.slice(-FAT_BREAK_HISTORY))) > FAT_BREAK_POINTS) {
			series++;
			current = [];
		}
		current.push(reading.fatPct);
		return { ...reading, series };
	});
}

function keytelNetKcal(hr: number, kg: number, age: number, minutes: number, bmr: number): number {
	const gross = (-55.0969 + 0.6309 * hr + 0.1988 * kg + 0.2017 * age) / 4.184;
	return Math.max(0, (gross - bmr / 1440) * minutes);
}

function conditioningKind(session: LoggedSession): "run" | "bike" | "other" {
	const text = `${session.modality ?? ""} ${session.name}`.toLowerCase();
	if (/\b(run|running|jog|jogging|track|sprints?|tempo|intervals?)\b/.test(text)) return "run";
	if (/bike|cycl|spin/.test(text)) return "bike";
	return "other";
}

type Model = { estimate: (date: string, scale: number) => DayEstimate | null };

function buildModel(inputs: ExpenditureInputs): Model {
	const weighIns = inputs.weighIns.toSorted((a, b) => a.date.localeCompare(b.date));
	const intake = new Map(inputs.intake.map((day) => [day.date, day.kcal]));
	const stepRows = inputs.steps.filter((day) => day.steps !== null && day.steps >= MIN_WORN_STEPS).toSorted((a, b) => a.date.localeCompare(b.date));
	const worn = new Map(stepRows.map((day) => [day.date, day.steps as number]));
	const fallbackSteps = stepRows.length === 0 ? 0 : median(stepRows.map((day) => day.steps as number));
	const comp = bodyCompSeries(inputs.bodyComp);
	const workouts = groupBy(inputs.workouts.filter((workout) => workout.durationS <= MAX_WORKOUT_S));
	const sessions = groupBy(inputs.sessions);
	const heightCm = (inputs.profile.heightM ?? DEFAULT_HEIGHT_M) * 100;

	const trendOn = (date: string): number | null => {
		const recent = between(weighIns, addDays(date, -(WEIGHT_LOOKBACK_DAYS - 1)), date);
		if (recent.length === 0) return null;
		const window = between(weighIns, addDays(date, -(TREND_DAYS - 1)), date);
		return window.length >= TREND_MIN_FIT ? fitLine(window).at(date) : mean(window.map((point) => point.lb));
	};

	const bmrOn = (date: string, kg: number): { bmr: number; method: BmrMethod } => {
		const upTo = between(comp, "0000-01-01", date);
		const latest = upTo.at(-1);
		if (latest !== undefined) {
			const fresh = between(upTo, addDays(date, -(FFM_DAYS - 1)), date).filter((reading) => reading.series === latest.series);
			if (fresh.length >= FFM_MIN_READINGS) return { bmr: 370 + 21.6 * median(fresh.map((reading) => reading.ffmKg)), method: "katch-mcardle" };
		}
		return { bmr: 10 * kg + 6.25 * heightCm - 5 * ageOn(inputs.profile.birthDate, date) + 5, method: "mifflin" };
	};

	const active = new Map(inputs.steps.flatMap((day) => (day.activeKcal === null || day.activeKcal === undefined || day.activeKcal < MIN_ACTIVE_KCAL ? [] : [[day.date, day.activeKcal] as const])));

	const stepsOn = (date: string): { count: number; from: StepsSource; activeKcal: number | null } => {
		const count = worn.get(date);
		if (count !== undefined) return { count, from: "count", activeKcal: null };
		const activeKcal = active.get(date);
		if (activeKcal !== undefined) return { count: 0, from: "active energy", activeKcal };
		const prior = between(stepRows, addDays(date, -STEP_MEDIAN_DAYS), addDays(date, -1));
		return { count: prior.length === 0 ? fallbackSteps : median(prior.map((day) => day.steps as number)), from: "median", activeKcal: null };
	};

	const trainingOn = (date: string, kg: number, bmr: number): TrainingItem[] => {
		const age = ageOn(inputs.profile.birthDate, date);
		const watch = workouts.get(date) ?? [];
		const logged = sessions.get(date) ?? [];
		const stepCost = (workout: WatchWorkout) => {
			const steps = workout.steps ?? (STEP_WORKOUTS.has(workout.category) && workout.distanceM ? workout.distanceM / (HIKES.has(workout.category) ? HIKE_STRIDE_M : RUN_STRIDE_M) : 0);
			return steps * STEP_KCAL_PER_KG * kg;
		};
		const stepWatch: TrainingItem[] = [];
		const nonStepWatch: TrainingItem[] = [];
		for (const workout of watch) {
			if (WALKS.has(workout.category)) continue;
			const measured = workout.activeKcal ?? (workout.hrAvg === null ? null : keytelNetKcal(workout.hrAvg, kg, age, workout.durationS / 60, bmr));
			if (measured === null) continue;
			const kcal = Math.max(0, measured - stepCost(workout));
			if (kcal === 0) continue;
			const item: TrainingItem = { name: workout.activity, kcal, source: workout.activeKcal === null ? "heart rate" : "watch" };
			(STEP_WORKOUTS.has(workout.category) ? stepWatch : nonStepWatch).push(item);
		}
		const watchCardio = watch.some((workout) => CARDIO.has(workout.category));
		const lifts: TrainingItem[] = logged.filter((session) => session.kind === "lift" && session.workingSets > 0).map((session) => ({ name: session.name, kcal: session.workingSets * LIFT_KCAL_PER_KG_SET * kg, source: "estimate" }));
		const conditioning: TrainingItem[] = watchCardio
			? []
			: logged
					.filter((session) => session.kind === "conditioning")
					.flatMap((session): TrainingItem[] => {
						const kind = conditioningKind(session);
						const hours = session.durationS === null ? null : session.durationS / 3600;
						const km = session.km ?? (kind === "run" && hours !== null ? hours * ASSUMED_RUN_KMH : null);
						const kcal = kind === "run" ? (km === null ? null : km * RUN_EXCESS_KCAL_PER_KG_KM * kg) : hours === null ? null : (kind === "bike" ? BIKE_NET_MET : OTHER_NET_MET) * kg * hours;
						return kcal === null || kcal <= 0 ? [] : [{ name: session.name, kcal, source: "estimate" }];
					});
		const liftTotal = sum(lifts.map((item) => item.kcal));
		const otherTotal = sum(nonStepWatch.map((item) => item.kcal));
		const strength = liftTotal > 0 && otherTotal > 0 ? (liftTotal >= otherTotal ? lifts : nonStepWatch) : [...lifts, ...nonStepWatch];
		return [...strength, ...stepWatch, ...conditioning];
	};

	return {
		estimate(date, scale) {
			const trendLb = trendOn(date);
			if (trendLb === null) return null;
			const kg = trendLb / LB_PER_KG;
			const { bmr, method } = bmrOn(date, kg);
			const living = LIVING_SHARE * bmr;
			const steps = stepsOn(date);
			const items = trainingOn(date, kg, bmr);
			const training = sum(items.map((item) => item.kcal));
			const stepKcal = steps.activeKcal === null ? steps.count * STEP_KCAL_PER_KG * kg : Math.max(0, steps.activeKcal - training);
			const base = scale * (bmr + living + stepKcal + training);
			const eaten = intake.get(date) ?? null;
			const tef = eaten === null ? (TEF_SHARE / (1 - TEF_SHARE)) * base : TEF_SHARE * eaten;
			return {
				date,
				total: base + tef,
				bmr: scale * bmr,
				bmrMethod: method,
				living: scale * living,
				steps: scale * stepKcal,
				stepCount: steps.from === "count" ? steps.count : null,
				stepsEstimated: steps.from === "median",
				stepsFrom: steps.from,
				training: scale * training,
				sessions: items.map((item) => ({ ...item, kcal: scale * item.kcal })),
				tef,
				intake: eaten,
				trendLb,
			};
		},
	};
}

type Block = { from: string; to: string; days: IntakeDay[] };

export function usableIntake(intake: readonly IntakeDay[]): IntakeDay[] {
	const bySource = new Map<string, IntakeDay[]>();
	for (const day of intake) bySource.set(day.source ?? LOGGED_SOURCE, [...(bySource.get(day.source ?? LOGGED_SOURCE) ?? []), day]);
	return [...bySource.entries()].flatMap(([source, days]) => {
		if (source === LOGGED_SOURCE) return days;
		const floor = PARTIAL_OF_MEDIAN * median(days.map((day) => day.kcal));
		return days.filter((day) => day.kcal >= floor);
	});
}

function loggedBlocks(intake: readonly IntakeDay[]): Block[] {
	const sources = [...new Set(intake.map((day) => day.source ?? LOGGED_SOURCE))];
	return sources.flatMap((source) => sourceBlocks(intake.filter((day) => (day.source ?? LOGGED_SOURCE) === source))).toSorted((a, b) => a.from.localeCompare(b.from));
}

function sourceBlocks(intake: readonly IntakeDay[]): Block[] {
	const sorted = intake.toSorted((a, b) => a.date.localeCompare(b.date));
	const blocks: Block[] = [];
	let start = 0;
	while (start < sorted.length) {
		const first = sorted[start] as IntakeDay;
		const candidates = between(sorted, first.date, addDays(first.date, MAX_WINDOW_DAYS - 1));
		const length = [...candidates.keys()]
			.map((index) => index + 1)
			.reverse()
			.find((count) => count >= CALIBRATION_MIN_DAYS && count / (dayNumber((candidates[count - 1] as IntakeDay).date) - dayNumber(first.date) + 1) >= MIN_COVERAGE);
		if (length === undefined) start++;
		else {
			const days = candidates.slice(0, length);
			blocks.push({ from: first.date, to: (days.at(-1) as IntakeDay).date, days });
			start += length;
		}
	}
	return blocks;
}

function measureBlock(block: Block, weighIns: readonly WeighIn[]): { tdee: number; se: number; weighIns: WeighIn[] } | null {
	const inside = between(weighIns, block.from, block.to);
	if (inside.length < 2) return null;
	const line = fitLine(inside);
	const intakeMean = mean(block.days.map((day) => day.kcal));
	return { tdee: intakeMean - line.slope * KCAL_PER_LB, se: Math.hypot(line.slopeSe * KCAL_PER_LB, INTAKE_ERROR * intakeMean), weighIns: inside };
}

function trackerRuns(tracker: readonly TrackerDay[]): TrackerDay[][] {
	const runs: TrackerDay[][] = [];
	for (const day of tracker.toSorted((a, b) => a.date.localeCompare(b.date))) {
		const run = runs.at(-1);
		const previous = run?.at(-1);
		if (run !== undefined && previous !== undefined && dayNumber(day.date) - dayNumber(previous.date) <= 1) run.push(day);
		else runs.push([day]);
	}
	return runs;
}

function datesFrom(from: string, to: string): string[] {
	const out: string[] = [];
	for (let day = dayNumber(from); day <= dayNumber(to); day++) out.push(isoDate(day));
	return out;
}

export function estimateExpenditure(inputs: ExpenditureInputs, from: string, to: string): ExpenditureResult {
	const usable = usableIntake(inputs.intake);
	const model = buildModel({ ...inputs, intake: usable });
	const weighIns = inputs.weighIns.toSorted((a, b) => a.date.localeCompare(b.date));
	const windows: CalibrationWindow[] = [];
	const fits: { s: number; sd: number }[] = [];
	const yearsAway = (first: string, last: string) => Math.max(0, dayNumber(from) - dayNumber(last), dayNumber(first) - dayNumber(to)) / 365.25;
	const addWindow = (kind: CalibrationWindow["kind"], source: string, dates: string[], tdee: number, se: number) => {
		const estimates = dates.map((date) => model.estimate(date, 1)).filter((day) => day !== null);
		if (estimates.length === 0) return;
		const base = mean(estimates.map((day) => day.total - day.tef));
		const tef = mean(estimates.map((day) => day.tef));
		const first = dates[0] as string;
		const last = dates.at(-1) as string;
		const s = (tdee - tef) / base;
		const sd = Math.hypot(se / base, DRIFT_PER_YEAR * yearsAway(first, last));
		windows.push({ kind, source, from: first, to: last, days: dates.length, tdee: Math.round(tdee), plusMinus: round10(se), scale: Math.round(s * 1000) / 1000, weight: 0 });
		fits.push({ s, sd });
	};
	for (const block of loggedBlocks(usable)) {
		const measured = measureBlock(block, weighIns);
		if (measured !== null && measured.weighIns.length >= CALIBRATION_MIN_WEIGH_INS) addWindow("logged", block.days[0]?.source ?? LOGGED_SOURCE, block.days.map((day) => day.date), measured.tdee, measured.se);
	}
	for (const run of trackerRuns(inputs.tracker)) addWindow("tracker", "tracker", run.map((day) => day.date), mean(run.map((day) => day.kcal)), TRACKER_SD);

	const precision = 1 / PRIOR_SD ** 2 + sum(fits.map((fit) => 1 / fit.sd ** 2));
	const scale = (1 / PRIOR_SD ** 2 + sum(fits.map((fit) => fit.s / fit.sd ** 2))) / precision;
	const scaleSd = Math.sqrt(1 / precision);
	fits.forEach((fit, index) => {
		const window = windows[index];
		if (window !== undefined) window.weight = Math.round((1 / fit.sd ** 2 / precision) * 1000) / 1000;
	});

	const days = datesFrom(from, to)
		.map((date) => model.estimate(date, scale))
		.filter((day) => day !== null);
	const inRange = usable.filter((day) => day.date >= from && day.date <= to);
	const result: ExpenditureResult = {
		tdee: null,
		plusMinus: null,
		basis: windows.length === 0 ? "estimated" : "calibrated",
		loggedDays: inRange.length,
		measured: rangeMeasured(inRange, weighIns),
		scale: { value: Math.round(scale * 1000) / 1000, sd: Math.round(scaleSd * 1000) / 1000, windows },
		components: null,
		days: days.map(roundDay),
	};
	if (days.length === 0) return result;
	const base = mean(days.map((day) => (day.total - day.tef) / scale));
	const imputedShare = days.filter((day) => day.stepsFrom === "median").length / days.length;
	return {
		...result,
		tdee: Math.round(mean(days.map((day) => day.total))),
		plusMinus: round10(Math.hypot(scaleSd * base, imputedShare * IMPUTED_STEPS_SD)),
		components: {
			bmr: Math.round(mean(days.map((day) => day.bmr))),
			living: Math.round(mean(days.map((day) => day.living))),
			steps: Math.round(mean(days.map((day) => day.steps))),
			training: Math.round(mean(days.map((day) => day.training))),
			tef: Math.round(mean(days.map((day) => day.tef))),
		},
	};
}

function rangeMeasured(logged: readonly IntakeDay[], weighIns: readonly WeighIn[]): Measured | null {
	if (logged.length < MEASURED_MIN_DAYS) return null;
	const sorted = logged.toSorted((a, b) => a.date.localeCompare(b.date));
	const block = { from: (sorted[0] as IntakeDay).date, to: (sorted.at(-1) as IntakeDay).date, days: sorted };
	const span = dayNumber(block.to) - dayNumber(block.from) + 1;
	if (span < MEASURED_MIN_DAYS || sorted.length / span < MIN_COVERAGE) return null;
	const measured = measureBlock(block, weighIns);
	if (measured === null || measured.weighIns.length < MEASURED_MIN_WEIGH_INS) return null;
	const firstWeighIn = (measured.weighIns[0] as WeighIn).date;
	const lastWeighIn = (measured.weighIns.at(-1) as WeighIn).date;
	if (dayNumber(firstWeighIn) - dayNumber(block.from) >= MEASURED_EDGE_DAYS || dayNumber(block.to) - dayNumber(lastWeighIn) >= MEASURED_EDGE_DAYS) return null;
	return { tdee: Math.round(measured.tdee), plusMinus: round10(measured.se), loggedDays: sorted.length, from: block.from, to: block.to };
}

function roundDay(day: DayEstimate): DayEstimate {
	return {
		...day,
		total: Math.round(day.total),
		bmr: Math.round(day.bmr),
		living: Math.round(day.living),
		steps: Math.round(day.steps),
		training: Math.round(day.training),
		sessions: day.sessions.map((item) => ({ ...item, kcal: Math.round(item.kcal) })),
		tef: Math.round(day.tef),
		intake: day.intake === null ? null : Math.round(day.intake),
		trendLb: Math.round(day.trendLb * 10) / 10,
	};
}
