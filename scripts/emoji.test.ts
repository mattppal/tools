import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolMeta } from "../src/tool.ts";
import { isEmoji } from "./emoji.ts";

const TOOLS_DIR = resolve(import.meta.dirname, "../tools");

test("isEmoji takes one emoji, including joined and variation-selected ones", () => {
	expect(["🎯", "🏋️", "⚙️", "👩‍💻", "🇺🇸"].map(isEmoji)).toEqual([true, true, true, true, true]);
	expect(["", "target", "🎯🎯", "🎯 ", "⚙"].map(isEmoji)).toEqual([false, false, false, false, false]);
});

test("every tool's icon is a single emoji", async () => {
	const slugs = readdirSync(TOOLS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	expect(slugs.length).toBeGreaterThan(0);
	for (const slug of slugs) {
		const meta: ToolMeta = (await import(resolve(TOOLS_DIR, slug, "tool.ts"))).default;
		expect({ slug, emoji: meta.emoji, single: isEmoji(meta.emoji) }).toEqual({ slug, emoji: meta.emoji, single: true });
	}
});
