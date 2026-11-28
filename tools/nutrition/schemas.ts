import { z } from "zod";
import { isIsoDate } from "./dates.ts";

export const isoDate = z.string().refine(isIsoDate, "Use a date like 2026-11-22");

const amount = z.number().nonnegative();

const foodInput = z.strictObject({
	food: z.string().trim().min(1),
	qty: z.number().positive(),
	unit: z.string().trim().min(1),
	kcal: amount,
	protein_g: amount,
	carbs_g: amount,
	fat_g: amount,
	fiber_g: amount.nullable().optional(),
	source: z.string().optional().describe('"USDA FDC <id> (label)", "Open Food Facts <barcode> (label)", or a note for an estimate'),
});

const clientKey = z.string().min(1);

const entryEdit = foodInput
	.partial()
	.extend({ id: z.number().int().optional(), client_key: clientKey.optional().describe("Picks the entry by the key it was added with, instead of id") })
	.refine((edit) => (edit.id === undefined) !== (edit.client_key === undefined), "Send exactly one of id or client_key");

export const foodChanges = z.strictObject({
	add: z
		.array(
			foodInput.extend({
				client_key: clientKey.optional().describe("Same key on a retry makes the add a no-op"),
				logged_at: z.iso.datetime({ offset: true }).optional().describe("When the food was eaten, like 2026-11-25T12:30:00-08:00. Defaults to now"),
			}),
		)
		.optional(),
	edit: z.array(entryEdit).optional(),
	remove: z
		.array(z.union([z.number().int(), clientKey]))
		.optional()
		.describe("Entry ids, or the client_key an entry was added with. An entry that is already gone is skipped, so a retry is safe"),
});

const score = z.number().min(0).max(10).nullable().optional();

export const dayUpdate = z.strictObject({
	bodyweight_lb: z.number().positive().nullable().optional().describe("Morning weigh-in"),
	steps: z.number().int().nonnegative().nullable().optional(),
	bloat_score: score,
	energy: score,
	sleep: score,
	stress: score,
	notes: z.string().optional(),
	estimated: z.boolean().optional().describe("Totals are estimates"),
	partial: z
		.boolean()
		.nullable()
		.optional()
		.describe("true marks the day partial: its kcal stay out of expenditure and phase math, its weigh-in still counts. false makes it count even under half its kcal target. null clears the mark"),
	closed: z.boolean().optional().describe("true closes the day, false reopens it"),
});

const range = z.strictObject({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() }).refine((value) => value.min <= value.max, "min must not be above max");

export const targetsInput = z.strictObject({
	effective_from: isoDate,
	kcal: range,
	protein_g: range,
	fat_g: range,
	carbs_g: range,
	notes: z.string().optional().describe("Goal, rules, and other plan text. Defaults to the previous version's notes"),
	change: z.string().min(1).describe("What changed and why"),
	steps_target: z.number().int().positive().nullable().optional().describe("Daily steps target. Omit to keep the previous version's target; null removes it"),
	current_kcal_target: z.number().int().positive().optional().describe("Sets the phase tracker's current kcal target, for example to apply the suggested kcal"),
});

export const PHASE_KINDS = ["maintain", "cut", "gain"] as const;

const tenths = (value: number) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;

export const phaseInput = z
	.strictObject({
		kind: z.enum(PHASE_KINDS).optional().describe("A kind other than the open phase's closes it and starts a new phase on start_date"),
		start_date: isoDate.optional().describe("May be in the future. Required when kind changes"),
		start_weight_override_lb: z.number().positive().lt(1000).nullable().optional().describe("null clears it, so the start weight is the 7-day average on start_date"),
		target_rate_per_week: z.number().min(-0.02).max(0.02).optional().describe("Fraction of bodyweight per week, compounded. Negative on a cut: -0.005 is 0.5% a week. Send this or target_lb_per_week"),
		target_lb_per_week: z.number().optional().describe("Pounds per week, negative on a cut. Converted to target_rate_per_week with the phase's start weight"),
		weeks: z.number().int().min(1).max(52).optional(),
		tolerance_lb: z.number().min(0.1).max(9.9).refine(tenths, "Use steps of 0.1 lb").optional(),
		max_weekly_kcal_change: z.number().int().positive().optional(),
		min_logged_days: z.number().int().min(1).max(7).optional(),
		current_kcal_target: z.number().int().positive().optional(),
	})
	.refine((input) => Object.values(input).some((value) => value !== undefined), "Send at least one field")
	.refine((input) => input.target_rate_per_week === undefined || input.target_lb_per_week === undefined, "Send target_rate_per_week or target_lb_per_week, not both");

export type FoodInput = z.infer<typeof foodInput>;
export type FoodChanges = z.infer<typeof foodChanges>;
export type DayUpdate = z.infer<typeof dayUpdate>;
export type TargetsInput = z.infer<typeof targetsInput>;
export type PhaseInput = z.infer<typeof phaseInput>;
