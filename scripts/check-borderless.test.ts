import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { findings } from "./check-borderless.ts";

const ROOT = resolve(import.meta.dirname, "..");
const css = (body: string) => `.probe {\n\t${body};\n}\n`;

describe("borderless gate", () => {
	test.each([
		["a token hairline", "src/probe.module.css", css("border: var(--border-width) solid var(--border-color)")],
		["a token divider", "tools/probe/probe.module.css", css("border-top: var(--border-width) solid var(--border-color)")],
		["a quiet edge", "src/probe.module.css", css("border: var(--border-width) solid transparent")],
		["a token shadow", "src/probe.module.css", css("box-shadow: var(--shadow-overlay)")],
		["no border on a pane", "src/shell/shell.module.css", css("border: 0")],
		["a transparent edge in the shell", "src/shell/shell.module.css", css("border-color: transparent")],
		["a hairline card in a list", "tools/probe/probe.module.css", ".setRow {\n\tborder: var(--border-width) solid var(--border-color);\n}\n"],
		["a quiet row edge", "tools/probe/probe.module.css", ".historyRow {\n\tborder-bottom: var(--border-width) solid transparent;\n}\n"],
		["no border on a table cell", "tools/probe/probe.module.css", ".table td {\n\tborder: 0;\n}\n"],
		["the style tokens in hairline.css", "src/styles/hairline.css", ":root {\n\t--border-width: 1px;\n\t--focus-ring: none;\n}\n"],
	])("passes %s", (_, file, source) => {
		expect(findings(file, source)).toEqual([]);
	});

	test.each([
		["a hard-coded hairline", "src/probe.module.css", css("border: 1px solid var(--line)"), "a border"],
		["a divider in --line", "tools/probe/probe.module.css", css("border-bottom: var(--border-width) solid var(--line)"), "a border"],
		["an inset hairline", "src/probe.module.css", css("box-shadow: inset 0 -1px var(--line)"), "a shadow"],
		["a soft drop shadow", "src/probe.module.css", css("box-shadow: 0 12px 32px -8px var(--overlay)"), "a shadow"],
		["a drop-shadow filter", "src/probe.module.css", css("filter: drop-shadow(0 1px 2px black)"), "a shadow"],
		["a hairline on the main pane", "src/shell/shell.module.css", css("border-inline-start: var(--border-width) solid var(--border-color)"), "a pane edge border"],
		["a hairline on the Details panel", "src/shell/tool-layout.module.css", css("border-left: var(--border-width) solid var(--border-color)"), "a pane edge border"],
		["a style token outside hairline.css", "src/styles/tokens.css", ":root {\n\t--border-width: 0px;\n}\n", "a style token set outside"],
		["a divider under table cells", "tools/probe/probe.module.css", ".table th,\n.table td {\n\tborder-bottom: var(--border-width) solid var(--border-color);\n}\n", "a row divider"],
		["a divider between list items", "tools/probe/probe.module.css", ".list li + li {\n\tborder-top: var(--border-width) solid var(--border-color);\n}\n", "a row divider"],
		["a divider on a row class", "tools/probe/probe.module.css", ".historyRow {\n\tborder-block-end: var(--border-width) solid var(--border-color);\n}\n", "a row divider"],
		["a divider in a media query", "tools/probe/probe.module.css", "@media (max-width: 639px) {\n\t.table tbody tr {\n\t\tborder-bottom: var(--border-width) solid var(--border-color);\n\t}\n}\n", "a row divider"],
		["grid lines on table cells", "tools/probe/probe.module.css", ".table td {\n\tborder: var(--border-width) solid var(--border-color);\n}\n", "a row divider"],
		["a divide-y class", "tools/probe/index.tsx", "<ul className=\"flex flex-col divide-y\" />\n", "a row divider class"],
		["a border-b class", "tools/probe/index.tsx", "<li className=\"border-b py-2\" />\n", "a row divider class"],
		["an inline shadow", "tools/probe/index.tsx", "<div style={{ boxShadow: \"0 1px 2px black\" }} />\n", "a shadow"],
	])("refuses %s", (_, file, source, mentions) => {
		const found = findings(file, source);
		expect(found).toHaveLength(1);
		expect(found[0]).toContain(mentions);
	});

	test("the repository passes", () => {
		const run = Bun.spawnSync([process.execPath, "scripts/check-borderless.ts"], { cwd: ROOT });
		expect(run.stderr.toString()).toBe("");
		expect(run.exitCode).toBe(0);
	});
});
