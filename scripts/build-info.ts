import { writeFile } from "node:fs/promises";

export type BuildInfo = { sha: string | null; branch: string | null };

function git(...args: string[]): string | null {
	const result = Bun.spawnSync(["git", ...args], { stderr: "ignore" });
	const output = result.stdout.toString().trim();
	return result.success && output !== "" ? output : null;
}

const info: BuildInfo = {
	sha: process.env.WORKERS_CI_COMMIT_SHA || git("rev-parse", "HEAD"),
	branch: process.env.WORKERS_CI_BRANCH || git("rev-parse", "--abbrev-ref", "HEAD"),
};

await writeFile(new URL("../public/build.json", import.meta.url), `${JSON.stringify(info)}\n`);
