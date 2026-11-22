import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_PATH = join(ROOT, ".env");
const KEY = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB";
const ORG = "mattppalmer";
const DATABASE = "tools";
const BRANCH = "preview";
const TTL_SECONDS = 7 * 24 * 60 * 60;

type Role = { username: string; password: string; access_host_url: string; database_name: string };

const id = process.env["PLANETSCALE_TOKEN_ID"];
const token = process.env["PLANETSCALE_API_TOKEN"];
if (!id || !token) {
	console.error(`Set PLANETSCALE_TOKEN_ID and PLANETSCALE_API_TOKEN, or put ${KEY}=postgres://... in .env yourself.`);
	process.exit(1);
}

const response = await fetch(`https://api.planetscale.com/v1/organizations/${ORG}/databases/${DATABASE}/branches/${BRANCH}/roles`, {
	method: "POST",
	headers: { authorization: `${id}:${token}`, "content-type": "application/json" },
	body: JSON.stringify({ name: `dev-${Date.now()}`, inherited_roles: ["postgres"], ttl: TTL_SECONDS }),
});
if (!response.ok) {
	console.error(`PlanetScale refused the role (${response.status}): ${await response.text()}`);
	process.exit(1);
}
const role = (await response.json()) as Role;
const url = `postgres://${encodeURIComponent(role.username)}:${encodeURIComponent(role.password)}@${role.access_host_url}:5432/${role.database_name}?sslmode=require`;

const existing = existsSync(ENV_PATH) ? await readFile(ENV_PATH, "utf-8") : "";
const kept = existing.split("\n").filter((line) => line !== "" && !line.startsWith(`${KEY}=`));
await writeFile(ENV_PATH, `${[...kept, `${KEY}=${url}`].join("\n")}\n`, { mode: 0o600 });

console.log(`Wrote ${KEY} to .env for the ${DATABASE}/${BRANCH} branch (expires in 7 days). Run \`bun run dev\`.`);
