import { z } from "zod";
import { isIsoDate } from "./dates.ts";

export const isoDate = z.string().refine(isIsoDate, "Use a date like 2026-11-22");

const amount = z.number().nonnegative();

const foodInput = z.object({
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

export const foodChanges = z.object({
	add: z.array(foodInput.extend({ client_key: clientKey.optional().describe("Same key on a retry makes the add a no-op") })).optional(),
	edit: z.array(entryEdit).optional(),
	remove: z
		.array(z.union([z.number().int(), clientKey]))
		.optional()
		.describe("Entry ids, or the client_key an entry was added with. An entry that is already gone is skipped, so a retry is safe"),
});

const score = z.number().min(0).max(10).nullable().optional();

export const dayUpdate = z.object({
	bodyweight_lb: z.number().positive().nullable().optional().describe("Morning weigh-in"),
	steps: z.number().int().nonnegative().nullable().optional(),
	bloat_score: score,
	energy: score,
	sleep: score,
	stress: score,
	notes: z.string().optional(),
	estimated: z.boolean().optional().describe("Totals are estimates"),
	closed: z.boolean().optional().describe("true closes the day, false reopens it"),
});

const range = z.object({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() }).refine((value) => value.min <= value.max, "min must not be above max");

export const targetsInput = z.object({
	effective_from: isoDate,
	kcal: range,
	protein_g: range,
	fat_g: range,
	carbs_g: range,
	notes: z.string().optional().describe("Goal, rules, and other plan text. Defaults to the previous version's notes"),
	change: z.string().min(1).describe("What changed and why"),
	current_kcal_target: z.number().int().positive().optional().describe("Sets the phase tracker's current kcal target, for example to apply the suggested kcal"),
});

export type FoodInput = z.infer<typeof foodInput>;
export type FoodChanges = z.infer<typeof foodChanges>;
export type DayUpdate = z.infer<typeof dayUpdate>;
export type TargetsInput = z.infer<typeof targetsInput>;
