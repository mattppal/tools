import { z } from "zod";
import { AREAS, HORIZONS, STATUSES } from "./types.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: string): boolean {
	const time = Date.parse(`${value}T00:00:00Z`);
	return DATE.test(value) && Number.isFinite(time) && new Date(time).toISOString().startsWith(value);
}

export const isoDate = z.string().refine(isIsoDate, "Use a date like 2026-11-22");
export const year = z.number().int().min(2000).max(2100);
export const area = z.enum(AREAS);
export const status = z.enum(STATUSES);
const quarter = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const uuid = z.uuid();
const text = z.string().trim().min(1);
const note = text.max(4000);
const progress = z.number().min(0).max(100).nullable().optional().describe("Percent toward the target, 0 to 100. Null when the goal has no measure");

const goalFields = z.strictObject({
	year,
	horizon: z.enum(HORIZONS),
	quarter: quarter.nullable().optional().describe("1 to 4 when horizon is quarter. Null or absent when horizon is year"),
	area,
	title: text.max(200),
	description: z.string().max(4000).optional(),
	metric: z.string().max(200).nullable().optional(),
	target: z.string().max(200).nullable().optional(),
	parent_id: uuid.nullable().optional().describe("A goal in the same year"),
	source_url: z.url().nullable().optional(),
});

const QUARTER_RULE = "quarter is 1-4 when horizon is quarter, and null or absent when horizon is year";
const quarterFits = (goal: { horizon?: string | undefined; quarter?: number | null | undefined }) => goal.horizon === undefined || goal.quarter === undefined || (goal.horizon === "quarter") === (goal.quarter !== null);
const quarterGiven = (goal: { horizon?: string | undefined; quarter?: number | null | undefined }) => goal.horizon !== "quarter" || (goal.quarter !== undefined && goal.quarter !== null);

export const upsertGoal = goalFields
	.partial()
	.extend({ id: uuid.optional().describe("Updates this goal. Fields you omit keep their values") })
	.refine((goal) => goal.id !== undefined || (goal.year !== undefined && goal.horizon !== undefined && goal.area !== undefined && goal.title !== undefined), "Without id, send year, horizon, area and title")
	.refine((goal) => quarterFits(goal) && (goal.id !== undefined || quarterGiven(goal)), QUARTER_RULE);

export const importGoal = goalFields
	.extend({
		status: status.optional().describe("Only a status the source states. Omitted means unknown for a new goal and unchanged for an existing one"),
		parent_title: text.optional().describe("Title of a year goal in the same year, in this import or already stored"),
	})
	.refine((goal) => quarterFits(goal) && quarterGiven(goal), QUARTER_RULE)
	.refine((goal) => goal.parent_id == null || goal.parent_title === undefined, "Send parent_id or parent_title, not both");

export const bulkImport = z.strictObject({
	goals: z.array(importGoal).min(1).max(200),
	years: z.array(z.strictObject({ year, north_star: z.string().max(500) })).max(50).optional(),
});

export const listGoals = z.strictObject({ year: year.optional(), area: area.optional(), status: status.optional() });

export const setStatus = z.strictObject({ id: uuid, status, note });

export const addCheckin = z.strictObject({ goal_id: uuid, note, progress, date: isoDate.optional().describe("Defaults to today in Matt's time zone") });

export const pageCheckin = addCheckin.extend({ status: status.optional().describe("Changes the goal's status with this check-in") });

export const linkTodoist = z.strictObject({
	goal_id: uuid,
	project_id: z.string().min(1).max(100).nullable().optional().describe("Omit to keep the stored project, null to clear it"),
	task_ids: z.array(z.string().min(1).max(100)).max(100).describe("Replaces the stored list. [] clears it"),
});

export const setNorthStar = z.strictObject({ year, north_star: z.string().max(500) });

export const getYear = z.strictObject({ year });

export type UpsertGoal = z.infer<typeof upsertGoal>;
export type ImportGoal = z.infer<typeof importGoal>;
export type BulkImport = z.infer<typeof bulkImport>;
export type ListGoals = z.infer<typeof listGoals>;
export type AddCheckin = z.infer<typeof pageCheckin>;
export type LinkTodoist = z.infer<typeof linkTodoist>;
