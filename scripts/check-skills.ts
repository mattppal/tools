import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");
const TOOLS_DIR = join(ROOT, "tools");
const LOCK_PATH = join(ROOT, "skills-lock.json");
const REPO_SKILL_PREFIX = "tools-";
const ENTRY_SKILL = "tools-start-here";
const REQUIRED_VENDORED = ["poteto-mode", "no-comments", "unslop", "emil-design-eng"];
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXCLUDED_FILES = new Set(["metadata.json"]);
const EXCLUDED_DIRS = new Set([".git", "__pycache__", "__pypackages__"]);

type LockEntry = { source: string; sourceType: string; skillPath: string; computedHash: string };
type Lock = { version: number; skills: Record<string, LockEntry> };
type FileEntry = { path: string; content: Buffer };

const problems: string[] = [];

function fail(message: string): void {
	problems.push(message);
}

async function collect(dir: string, prefix: string, root: string, out: FileEntry[]): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (EXCLUDED_FILES.has(entry.name) || (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name))) continue;
		const full = join(dir, entry.name);
		let directory = entry.isDirectory();
		if (entry.isSymbolicLink()) {
			const target = await realpath(full).catch(() => null);
			if (target === null || (target !== root && !target.startsWith(root + sep))) continue;
			directory = (await stat(target)).isDirectory();
		} else if (!directory && !entry.isFile()) continue;
		if (directory) await collect(full, `${prefix}${entry.name}/`, root, out);
		else out.push({ path: prefix + entry.name, content: await readFile(full) });
	}
}

function normalize(content: Buffer): Buffer {
	if (content.includes(0) || !content.includes("\r\n")) return content;
	return Buffer.from(content.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
}

async function folderHash(dir: string): Promise<string> {
	const files: FileEntry[] = [];
	await collect(dir, "", await realpath(dir), files);
	const entries = files.map((file) => ({ path: Buffer.from(file.path, "utf-8"), content: normalize(file.content) }));
	entries.sort((a, b) => Buffer.compare(a.path, b.path));
	const hash = createHash("sha256");
	for (const { path, content } of entries) {
		hash.update(path);
		hash.update("\0");
		hash.update(String(content.length));
		hash.update("\0");
		hash.update(content);
	}
	return hash.digest("hex");
}

function frontmatter(text: string): Record<string, unknown> | string {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (match === null) return "missing YAML frontmatter";
	try {
		const parsed: unknown = Bun.YAML.parse(match[1] ?? "");
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "frontmatter is not a mapping";
		return Object.fromEntries(Object.entries(parsed));
	} catch (error) {
		return `invalid YAML: ${error instanceof Error ? error.message : String(error)}`;
	}
}

async function checkSkillFile(file: string, expectedName: string): Promise<void> {
	const label = file.slice(ROOT.length + 1);
	if (!existsSync(file)) return fail(`${label} is missing`);
	const meta = frontmatter(await readFile(file, "utf-8"));
	if (typeof meta === "string") return fail(`${label}: ${meta}`);
	const { name, description } = meta;
	if (typeof name !== "string" || !NAME.test(name)) fail(`${label}: name must be kebab-case`);
	else if (name !== expectedName) fail(`${label}: name is "${name}", expected "${expectedName}"`);
	if (typeof description !== "string" || description.trim() === "") fail(`${label}: description is required`);
	else if (description.length > 1024) fail(`${label}: description is over 1024 characters`);
}

async function directories(dir: string): Promise<string[]> {
	if (!existsSync(dir)) return [];
	return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function readLock(): Promise<Lock | null> {
	if (!existsSync(LOCK_PATH)) {
		fail("skills-lock.json is missing");
		return null;
	}
	try {
		return JSON.parse(await readFile(LOCK_PATH, "utf-8")) as Lock;
	} catch (error) {
		fail(`skills-lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

async function main(): Promise<void> {
	const lock = await readLock();
	const locked = lock?.skills ?? {};
	const skillDirs = await directories(SKILLS_DIR);

	for (const name of skillDirs) {
		await checkSkillFile(join(SKILLS_DIR, name, "SKILL.md"), name);
		if (name.startsWith(REPO_SKILL_PREFIX)) {
			if (name in locked) fail(`skills-lock.json: "${name}" is a repo skill and must not be locked`);
			continue;
		}
		const entry = locked[name];
		if (entry === undefined) {
			fail(`skills/${name} is vendored but has no skills-lock.json entry (install with \`bunx skills add <source> --skill ${name}\`, or rename it ${REPO_SKILL_PREFIX}${name} if it belongs to this repo)`);
			continue;
		}
		const actual = await folderHash(join(SKILLS_DIR, name));
		if (actual !== entry.computedHash) fail(`skills/${name} does not match its skills-lock.json hash; vendored skills are edited upstream, not here`);
	}

	for (const name of Object.keys(locked)) {
		if (!skillDirs.includes(name)) fail(`skills-lock.json lists "${name}" but skills/${name} is missing`);
	}
	for (const name of [ENTRY_SKILL, ...REQUIRED_VENDORED]) {
		if (!skillDirs.includes(name)) fail(`skills/${name} is required`);
	}

	for (const slug of await directories(TOOLS_DIR)) {
		if (!NAME.test(slug)) fail(`tools/${slug}: tool directories must be kebab-case`);
		await checkSkillFile(join(TOOLS_DIR, slug, "SKILL.md"), `tool-${slug}`);
	}

	const agents = existsSync(join(ROOT, "AGENTS.md")) ? await readFile(join(ROOT, "AGENTS.md"), "utf-8") : "";
	if (!agents.includes(`skills/${ENTRY_SKILL}/SKILL.md`)) fail(`AGENTS.md must point to skills/${ENTRY_SKILL}/SKILL.md`);

	if (problems.length > 0) {
		console.error(`Skill check failed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
		process.exit(1);
	}
	console.log(`Skill check passed: ${skillDirs.length} skills, ${(await directories(TOOLS_DIR)).length} tool skills.`);
}

await main();
