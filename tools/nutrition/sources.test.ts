import { expect, test } from "bun:test";
import { formatSource, parseSource } from "./sources.ts";

test("formats a source the way the bot writes it, and parses back to the same parts", () => {
	for (const text of ["USDA FDC 170894 (Yogurt, Greek, plain, nonfat)", "Open Food Facts 0041196910759 (Fairlife whole)", "USDA FDC 172183", "label estimate, 2 slices", ""]) {
		const { kind, ref, label } = parseSource(text);
		expect(formatSource(kind, ref, label)).toBe(text);
	}
	expect(formatSource("tracker_export", null, "MacroFactor export")).toBe("MacroFactor export");
});
