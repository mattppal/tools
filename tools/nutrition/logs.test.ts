import { expect, test } from "bun:test";
import { clockTime } from "./dates.ts";
import { groupLogs } from "./logs.ts";
import type { FoodEntry } from "./types.ts";

let nextId = 1;

function entry(clientKey: string, loggedAt: string | null): FoodEntry {
	return { id: nextId++, food: clientKey, qty: 1, unit: "g", kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: null, sourceKind: "estimate", sourceRef: null, sourceLabel: "", source: "", clientKey, loggedAt };
}

const at = (time: string) => `2026-11-24T${time}-08:00`;

test("entries logged within a few minutes form one log, in time order", () => {
	const day = [
		entry("bot:t88u:0", at("20:11:03")),
		entry("bot:t77u:0", at("09:07:25")),
		entry("bot:t77u:1", at("09:07:25")),
		entry("bot:t78u:0", at("11:58:14")),
		entry("bot:t79u:0", at("11:58:48")),
		entry("bot:t85ua0:0", at("18:30:07")),
		entry("bot:t85u:0", at("19:14:14")),
		entry("bot:t85u:1", at("19:14:14")),
	];
	const logs = groupLogs(day);
	expect(logs.map((log) => [log.at === null ? null : clockTime(log.at), log.entries.map((item) => item.clientKey)])).toEqual([
		["9:07 AM", ["bot:t77u:0", "bot:t77u:1"]],
		["11:58 AM", ["bot:t78u:0", "bot:t79u:0"]],
		["6:30 PM", ["bot:t85ua0:0"]],
		["7:14 PM", ["bot:t85u:0", "bot:t85u:1"]],
		["8:11 PM", ["bot:t88u:0"]],
	]);
});

test("one bot message stays one log even when its foods carry different times", () => {
	const logs = groupLogs([entry("bot:m1:0", at("12:00:00")), entry("bot:m1:1", at("12:40:00")), entry("ui-key", at("13:30:00"))]);
	expect(logs.map((log) => log.entries.length)).toEqual([2, 1]);
});

test("entries without a time come first, under no time", () => {
	const logs = groupLogs([entry("bot:m2:0", at("08:00:00")), entry("import:2026-10-01:0", null), entry("import:2026-10-01:1", null)]);
	expect(logs.map((log) => [log.at, log.entries.length])).toEqual([
		[null, 2],
		[at("08:00:00"), 1],
	]);
});
