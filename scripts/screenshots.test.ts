import { expect, test } from "bun:test";
import { fileName, SHOTS, VIEWPORTS } from "./screenshots.ts";

test("every screenshot gets its own file name in every viewport", () => {
	const names = VIEWPORTS.flatMap((viewport) => SHOTS.map((shot) => fileName(shot, viewport)));
	expect(new Set(names).size).toBe(names.length);
	expect(names).toContain("unified-tdee-desktop-dark-panel.png");
	expect(names).toContain("unified-tdee-mobile-summary.png");
});

test("the viewports are desktop light and dark at 1440x1000 and a 390x844 phone", () => {
	expect(VIEWPORTS.map(({ name, width, height, scheme }) => `${name} ${width}x${height} ${scheme}`)).toEqual(["desktop 1440x1000 light", "desktop-dark 1440x1000 dark", "mobile 390x844 light"]);
});
