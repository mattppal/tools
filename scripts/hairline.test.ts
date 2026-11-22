import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8");
const declared = (css: string) => Object.fromEntries([...css.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((match) => [match[1], match[2]?.trim()]));
const preset: { tokens: Record<string, string> } = JSON.parse(read("src/styles/presets/hairline.json"));

test("Hairline ships one 1px --line edge with no shadows and no ring", () => {
	expect({
		"--border-width": preset.tokens["--border-width"],
		"--border-color": preset.tokens["--border-color"],
		"--shadow-surface": preset.tokens["--shadow-surface"],
		"--shadow-raised": preset.tokens["--shadow-raised"],
		"--shadow-overlay": preset.tokens["--shadow-overlay"],
		"--focus-ring": preset.tokens["--focus-ring"],
	}).toEqual({
		"--border-width": "1px",
		"--border-color": "var(--line)",
		"--shadow-surface": "none",
		"--shadow-raised": "none",
		"--shadow-overlay": "none",
		"--focus-ring": "none",
	});
});

test("hairline.css is the preset, and tokens.css overrides none of it", () => {
	expect(declared(read("src/styles/hairline.css"))).toEqual(preset.tokens);
	const overridden = Object.keys(declared(read("src/styles/tokens.css"))).filter((name) => name in preset.tokens);
	expect(overridden).toEqual([]);
});

test("with no ring, keyboard focus still shows as a fill", () => {
	const focus = read("src/styles/focus.css");
	expect(focus).toMatch(/:is\(a\[href\], button, summary\):focus-visible[^{]*\{[^}]*background-color: var\(--focus-fill, var\(--focus-bg\)\)/);
	expect(focus).toMatch(/:is\(input, textarea, select\):focus-visible \{[^}]*--field-bg: var\(--field-focus\)/);
});
