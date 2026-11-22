import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRole, roleUrl } from "./planetscale.ts";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_PATH = join(ROOT, ".env");
const KEY = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB";
const TTL_SECONDS = 7 * 24 * 60 * 60;

let url: string;
try {
	url = roleUrl(await createRole("preview", `dev-${Date.now()}`, TTL_SECONDS));
} catch (error) {
	console.error(`${error instanceof Error ? error.message : error} Or put ${KEY}=postgres://... in .env yourself.`);
	process.exit(1);
}

const existing = existsSync(ENV_PATH) ? await readFile(ENV_PATH, "utf-8") : "";
const kept = existing.split("\n").filter((line) => line !== "" && !line.startsWith(`${KEY}=`));
await writeFile(ENV_PATH, `${[...kept, `${KEY}=${url}`].join("\n")}\n`, { mode: 0o600 });

console.log(`Wrote ${KEY} to .env for the tools/preview branch (expires in 7 days). Run \`bun run dev\`.`);
