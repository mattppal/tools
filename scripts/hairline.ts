import { readFileSync, writeFileSync } from "node:fs";

const source = "src/styles/presets/hairline.json";
const target = "src/styles/hairline.css";

const preset: { name: string; tokens: Record<string, string> } = JSON.parse(readFileSync(source, "utf8"));
const lines = Object.entries(preset.tokens).map(([name, value]) => `\t${name}: ${value};`);
const css = `/* Generated from ${source} by \`bun run hairline\`. Edit the JSON, not this file. */\n:root {\n${lines.join("\n")}\n}\n`;

if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(target, "utf8");
	} catch {}
	if (current !== css) {
		console.error(`${target} is out of date with ${source}. Run \`bun run hairline\`.`);
		process.exit(1);
	}
} else {
	writeFileSync(target, css);
	console.log(`wrote ${target} (${lines.length} tokens from ${preset.name})`);
}
