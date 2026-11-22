import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dirname, "..");
const SCANNED = ["src/**/*.{css,ts,tsx}", "tools/**/*.{css,ts,tsx}"];
const TOKENS = "src/styles/hairline.css";
const PANES = new Set(["src/shell/shell.module.css", "src/shell/tool-layout.module.css"]);

const BORDER = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-(color|width|style))?$/;
const NO_BORDER = /^(0|none)(\s*!important)?$/;
const SHADOW = /^(box-shadow|text-shadow|-webkit-box-shadow)$|^--.*shadow/;
const NO_SHADOW = /^none(\s*!important)?$/;
const INLINE_SHADOW = /\b(boxShadow|textShadow|box-shadow|text-shadow)\b|drop-shadow\(/;
const STYLE_TOKEN = /^--(border-width|border-color|shadow-(surface|raised|overlay)|focus-ring)$/;
const EDGE_COLOR = /^(var\(--border-color\)|transparent)$/;
const TOKEN_SHADOW = /^var\(--shadow-(surface|raised|overlay)\)$/;

type Declaration = { property: string; value: string; offset: number };

function declarations(source: string): Declaration[] {
	const found: Declaration[] = [];
	let start = 0;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === "{") start = index + 1;
		else if (char === "}" || char === ";") {
			const text = source.slice(start, index);
			const colon = text.indexOf(":");
			if (colon !== -1 && !text.trim().startsWith("@")) {
				found.push({ property: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).trim(), offset: start + text.length - text.trimStart().length });
			}
			start = index + 1;
		}
	}
	return found;
}

function lineAt(source: string, offset: number): number {
	return source.slice(0, offset).split("\n").length;
}

function tokenBorder(property: string, value: string): boolean {
	if (property.endsWith("-width")) return value === "var(--border-width)";
	if (property.endsWith("-color")) return EDGE_COLOR.test(value);
	if (property.endsWith("-style")) return value === "solid";
	const [width, style, ...color] = value.split(/\s+/);
	return width === "var(--border-width)" && style === "solid" && EDGE_COLOR.test(color.join(" "));
}

function reason({ property, value }: Declaration, file: string): string | null {
	if (STYLE_TOKEN.test(property)) return file === TOKENS ? null : `a style token set outside ${TOKENS}`;
	if (BORDER.test(property) && PANES.has(file)) return NO_BORDER.test(value) || value === "transparent" ? null : "a pane edge border; the sidebar, main pane and Details panel separate by shade only";
	if (BORDER.test(property)) return NO_BORDER.test(value) || tokenBorder(property, value) ? null : "a border that doesn't read the style tokens";
	if (SHADOW.test(property)) return NO_SHADOW.test(value) || TOKEN_SHADOW.test(value) ? null : "a shadow that doesn't read the style tokens";
	if (/drop-shadow\(/.test(value)) return "a shadow";
	return null;
}

export function findings(file: string, source: string): string[] {
	if (file.endsWith(".css")) {
		return declarations(source).flatMap((declaration) => {
			const found = reason(declaration, file);
			return found === null ? [] : [`${file}:${lineAt(source, declaration.offset)} uses ${found} in "${declaration.property}: ${declaration.value}"`];
		});
	}
	return source.split("\n").flatMap((line, index) => (INLINE_SHADOW.test(line) ? [`${file}:${index + 1} uses a shadow in "${line.trim()}"`] : []));
}

if (import.meta.main) {
	const files = process.argv.length > 2 ? process.argv.slice(2).map((file) => relative(ROOT, resolve(file))) : SCANNED.flatMap((pattern) => [...new Glob(pattern).scanSync({ cwd: ROOT, onlyFiles: true })]).filter((file) => !/\.test\.tsx?$/.test(file));
	const found = files.sort().flatMap((file) => findings(file, readFileSync(resolve(ROOT, file), "utf8")));
	if (found.length > 0) {
		console.error(found.join("\n"));
		console.error(`\n${found.length} borders or shadows found. A border reads the style tokens: border: var(--border-width) solid var(--border-color), or an edge-* utility from src/styles/kit.css. A shadow reads var(--shadow-surface|raised|overlay). Only ${TOKENS}, generated from src/styles/presets/hairline.json, sets them; they ship as Hairline, 1px var(--line) with no shadows and no focus ring. The shell's panes in ${[...PANES].join(" and ")} take no border at all.`);
		process.exit(1);
	}
	console.log(`Borderless check passed: ${files.length} files.`);
}
