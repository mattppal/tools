import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "..");
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const { values, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		name: { type: "string" },
		description: { type: "string" },
		icon: { type: "string", default: "tool" },
		api: { type: "boolean", default: false },
	},
});

function usage(message: string): never {
	console.error(`${message}\nUsage: bun run new-tool <slug> [--name "Name"] [--description "One line."] [--icon tool] [--api]`);
	process.exit(1);
}

const slug = positionals[0];
if (slug === undefined) usage("Missing slug.");
if (!SLUG.test(slug)) usage(`"${slug}" is not kebab-case.`);

const dir = join(ROOT, "tools", slug);
if (existsSync(dir)) usage(`tools/${slug} already exists.`);

const icons = await readFile(join(ROOT, "src/shell/icons.tsx"), "utf-8");
const icon = values.icon ?? "tool";
if (!new RegExp(`^\\t"?${icon}"?:`, "m").test(icons)) usage(`Unknown icon "${icon}". Pick a key of GLYPHS in src/shell/icons.tsx.`);

const name = values.name ?? slug.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
const description = values.description ?? `${name}.`;
const component = name.replace(/[^A-Za-z0-9]/g, "") || "Tool";
const quoted = (text: string) => JSON.stringify(text);

const files: Record<string, string> = {
	"tool.ts": `import { defineTool } from "../../src/tool.ts";

export default defineTool({
	name: ${quoted(name)},
	description: ${quoted(description)},
	icon: ${quoted(icon)},
});
`,
	"index.tsx": `import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import styles from "./${slug}.module.css";

export default function ${component}() {
	return (
		<ToolLayout title=${quoted(name)}>
			<div className={styles.page}>
				<p>${description.replace(/[<>{}]/g, "")}</p>
			</div>
		</ToolLayout>
	);
}
`,
	[`${slug}.module.css`]: `.page {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	max-width: 720px;
	padding-top: var(--space-4);
}
`,
	"SKILL.md": `---
name: tool-${slug}
description: ${quoted(`The ${name} tool at /${slug}. ${description} Use when changing tools/${slug}/.`)}
---

# ${name}

${description}

## UI

- \`index.tsx\` renders \`ToolLayout\`. No secondary sidebar or right panel yet.

## API

${values.api ? `- \`GET /api/tools/${slug}/ping\` returns \`{ ok: true }\`.` : "None."}

## Data

None.
`,
};

if (values.api) {
	files["api.ts"] = `import { defineToolApi } from "../../worker/tool-api.ts";

export default defineToolApi((request, { path }) => {
	if (request.method === "GET" && path === "/ping") return Response.json({ ok: true });
	return Response.json({ error: "Not found" }, { status: 404 });
});
`;
}

await mkdir(dir, { recursive: true });
await Promise.all(Object.entries(files).map(([file, contents]) => writeFile(join(dir, file), contents)));

console.log(`Created tools/${slug}/ (${Object.keys(files).join(", ")}). Open /${slug} in \`bun run dev\`.`);
