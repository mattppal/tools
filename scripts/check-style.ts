import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dirname, "..");
const SCANNED = ["src/**/*.{ts,tsx,css}", "worker/**/*.ts", "tools/**/*.{ts,tsx,css,sql}", "scripts/**/*.ts", "e2e/**/*.ts", "index.html", "vite.config.ts"];
const GENERATED = new Set(["tools/workouts/openweight/workout-log-validator.js", "tools/workouts/openweight/workout-log-validator.d.ts"]);
const DOT_MAX_PX = 14;
const FULL_RADIUS = /^(?:var\(--radius-full\)|50%|100%|\d{3,}px)$/;
const TAILWIND_DOT = /\brounded-full\b/;
const TAILWIND_SMALL = /\b(?:size|w|h)-(?:0\.5|1|1\.5|2|2\.5|3|3\.5|\[(?:[1-9]|1[0-4])px\])(?=\s|$|["'`])/g;

type Problem = { file: string; line: number; message: string };
const problems: Problem[] = [];

const COMMENT_FIX = "Delete it. If it states a constraint, encode the constraint as a type, a check, or a test.";
const DOT_FIX = 'Say the state in words instead (tools-styling, "No status dots").';
const PILL_FIX = 'Say the state in plain text in the surrounding style instead (tools-styling, "No status pills").';

function lineAt(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

const REGEX_PRECEDES = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const LINE_COMMENT_PRECEDES = /[\s;{}(),]/;

function scriptComments(text: string): number[] {
	const found: number[] = [];
	const templateDepth: number[] = [];
	let braceDepth = 0;
	let lastSignificant = "";
	let i = 0;
	const skipString = (quote: string) => {
		i++;
		while (i < text.length && text[i] !== quote && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
		i++;
	};
	const skipTemplate = () => {
		i++;
		while (i < text.length) {
			if (text[i] === "\\") i += 2;
			else if (text[i] === "`") {
				i++;
				return;
			} else if (text[i] === "$" && text[i + 1] === "{") {
				templateDepth.push(braceDepth);
				braceDepth++;
				i += 2;
				return;
			} else i++;
		}
	};
	while (i < text.length) {
		const char = text[i] ?? "";
		const next = text[i + 1];
		if (char === "/" && next === "/" && (i === 0 || LINE_COMMENT_PRECEDES.test(text[i - 1] ?? ""))) {
			found.push(i);
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (char === "/" && next === "*") {
			found.push(i);
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
			continue;
		}
		if (char === "'" || char === '"') {
			skipString(char);
			lastSignificant = "a";
			continue;
		}
		if (char === "`") {
			skipTemplate();
			lastSignificant = "a";
			continue;
		}
		if (char === "/" && (lastSignificant === "" || REGEX_PRECEDES.has(lastSignificant) || /\b(?:return|typeof|case|in|of)\s*$/.test(text.slice(Math.max(0, i - 8), i)))) {
			i++;
			let inClass = false;
			while (i < text.length && text[i] !== "\n") {
				if (text[i] === "\\") i++;
				else if (text[i] === "[") inClass = true;
				else if (text[i] === "]") inClass = false;
				else if (text[i] === "/" && !inClass) break;
				i++;
			}
			i++;
			lastSignificant = "a";
			continue;
		}
		if (char === "{") braceDepth++;
		if (char === "}") {
			braceDepth--;
			if (templateDepth.at(-1) === braceDepth) {
				templateDepth.pop();
				i--;
				skipTemplate();
				lastSignificant = "a";
				continue;
			}
		}
		if (!/\s/.test(char)) lastSignificant = char;
		i++;
	}
	return found;
}

function cssComments(text: string): number[] {
	const found: number[] = [];
	for (const match of text.matchAll(/\/\*/g)) found.push(match.index);
	return found;
}

function sqlComments(text: string): number[] {
	const found: number[] = [];
	for (const match of text.matchAll(/--|\/\*/g)) {
		const before = text.slice(text.lastIndexOf("\n", match.index) + 1, match.index);
		if ((before.match(/'/g)?.length ?? 0) % 2 === 0) found.push(match.index);
	}
	return found;
}

function htmlComments(text: string): number[] {
	return [...text.matchAll(/<!--/g)].map((match) => match.index);
}

function px(value: string | undefined): number | null {
	if (value === undefined) return null;
	const match = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(value.trim());
	if (match === null) return null;
	return Number(match[1]) * (match[2] === "rem" ? 16 : 1);
}

function cssDots(file: string, text: string): void {
	for (const block of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const declarations = new Map<string, string>();
		for (const declaration of (block[2] ?? "").split(";")) {
			const colon = declaration.indexOf(":");
			if (colon > 0) declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
		}
		const radius = declarations.get("border-radius");
		if (radius === undefined || !FULL_RADIUS.test(radius)) continue;
		const selector = (block[1] ?? "").trim().split("\n").at(-1)?.trim() ?? "";
		const line = lineAt(text, block.index + (block[1] ?? "").length);
		const background = declarations.get("background") ?? declarations.get("background-color");
		const padded = [...declarations.keys()].some((name) => name.startsWith("padding"));
		if (padded && background !== undefined && background !== "transparent" && background !== "none" && declarations.get("cursor") !== "pointer") {
			problems.push({ file, line, message: `${selector} draws a status pill (fully rounded, padded, filled, not clickable). ${PILL_FIX}` });
			continue;
		}
		const width = px(declarations.get("width") ?? declarations.get("inline-size"));
		const height = px(declarations.get("height") ?? declarations.get("block-size"));
		if (width === null || height === null || width > DOT_MAX_PX || height > DOT_MAX_PX) continue;
		problems.push({ file, line, message: `${selector} draws a status dot (${width}x${height}px, fully rounded). ${DOT_FIX}` });
	}
}

function tailwindDots(file: string, text: string): void {
	for (const literal of text.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
		const classes = literal[2] ?? "";
		if (!TAILWIND_DOT.test(classes)) continue;
		const small = [...classes.matchAll(TAILWIND_SMALL)].map((match) => match[0]);
		const hasSize = small.some((name) => name.startsWith("size-"));
		const hasBoth = small.some((name) => name.startsWith("w-")) && small.some((name) => name.startsWith("h-"));
		if (!hasSize && !hasBoth) continue;
		problems.push({ file, line: lineAt(text, literal.index), message: `classes "${small.join(" ")} rounded-full" draw a status dot. ${DOT_FIX}` });
	}
}

function withoutMinmax(value: string): string {
	let out = "";
	let i = 0;
	while (i < value.length) {
		if (value.startsWith("minmax(", i)) {
			let depth = 0;
			for (i += "minmax".length; i < value.length; i++) {
				if (value[i] === "(") depth++;
				else if (value[i] === ")" && --depth === 0) break;
			}
			i++;
			continue;
		}
		out += value[i];
		i++;
	}
	return out;
}

function cssGridTracks(file: string, text: string): void {
	for (const declaration of text.matchAll(/grid-template-columns\s*:\s*([^;}]+)/g)) {
		if (!/\d*\.?\d+fr\b/.test(withoutMinmax(declaration[1] ?? ""))) continue;
		problems.push({ file, line: lineAt(text, declaration.index), message: "a bare fr track can't shrink below its content, so long text overflows into the next column. Use minmax(0, 1fr)." });
	}
}

function toolConnections(file: string, text: string): void {
	for (const use of text.matchAll(/\bwithRequestDb\b/g)) {
		problems.push({ file, line: lineAt(text, use.index), message: `a tool opens its own connection. Use the db() a tool gets, and deliverSoon from worker/webhooks.ts for a first delivery attempt.` });
	}
}

const files = new Set<string>();
for (const pattern of SCANNED) for await (const path of new Glob(pattern).scan({ cwd: ROOT, onlyFiles: true })) if (!GENERATED.has(path)) files.add(path);

for (const file of [...files].sort()) {
	const text = await readFile(join(ROOT, file), "utf8");
	const comments = file.endsWith(".css") ? cssComments(text) : file.endsWith(".sql") ? sqlComments(text) : file.endsWith(".html") ? htmlComments(text) : scriptComments(text);
	for (const index of comments) problems.push({ file, line: lineAt(text, index), message: `code comment. ${COMMENT_FIX}` });
	if (file.endsWith(".css")) {
		cssDots(file, text);
		cssGridTracks(file, text);
	}
	if (file.endsWith(".tsx")) tailwindDots(file, text);
	if (file.startsWith("tools/") && !/\.test\.tsx?$/.test(file)) toolConnections(file, text);
}

if (problems.length > 0) {
	console.error("Style check failed:");
	for (const problem of problems) console.error(`  ${relative(ROOT, join(ROOT, problem.file))}:${problem.line}: ${problem.message}`);
	process.exit(1);
}
console.log(`Style check passed: ${files.size} files.`);
