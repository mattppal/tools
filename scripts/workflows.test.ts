import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = resolve(import.meta.dirname, "../.github/workflows");
const workflows = readdirSync(DIR)
	.filter((name) => /\.ya?ml$/.test(name))
	.map((name) => ({ name, text: readFileSync(join(DIR, name), "utf8") }));

test("there is at least one workflow to check", () => {
	expect(workflows.length).toBeGreaterThan(0);
});

test("every third-party action is pinned to a full commit SHA", () => {
	const unpinned = workflows.flatMap(({ name, text }) =>
		[...text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1] ?? "").filter((ref) => !ref.startsWith("./") && !/@[0-9a-f]{40}$/.test(ref)).map((ref) => `${name}: ${ref}`),
	);
	expect(unpinned).toEqual([]);
});

test("every workflow declares a top-level permissions block and never grants write-all", () => {
	for (const { name, text } of workflows) {
		expect({ name, permissions: /^permissions:/m.test(text) }).toEqual({ name, permissions: true });
		expect({ name, writeAll: /permissions:\s*write-all/.test(text) }).toEqual({ name, writeAll: false });
	}
});

test("no workflow runs untrusted pull request code with secrets", () => {
	for (const { name, text } of workflows) expect({ name, pullRequestTarget: /\bpull_request_target\b/.test(text) }).toEqual({ name, pullRequestTarget: false });
});
