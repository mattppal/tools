import { expect, test } from "bun:test";
import { onCadence } from "./tool-api.ts";

test("a cadence picks the scheduled minutes that divide evenly, whatever the seconds", () => {
	const minutes = Array.from({ length: 30 }, (_, minute) => new Date(Date.UTC(2026, 10, 25, 16, minute, 0, 400)));
	expect(minutes.filter((at) => onCadence(at, 10)).map((at) => at.getUTCMinutes())).toEqual([0, 10, 20]);
	expect(minutes.filter((at) => onCadence(at, 5)).map((at) => at.getUTCMinutes())).toEqual([0, 5, 10, 15, 20, 25]);
	expect(minutes.every((at) => onCadence(at, 1))).toBe(true);
});
