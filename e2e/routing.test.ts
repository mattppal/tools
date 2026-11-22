import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const ROOT = resolve(import.meta.dirname, "..");
const CLIENT = join(ROOT, "dist/client");
const ASSETS = join(CLIENT, "assets");
const IMAGE_PATH = /["'`(](\/[\w./-]+\.(?:png|svg|webp|avif|jpe?g|gif|ico))["'`)]/g;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PORT = 4300 + (process.pid % 600);
const BASE = `http://127.0.0.1:${PORT}`;
const START_TIMEOUT_MS = 30_000;

let preview: Subprocess;

beforeAll(async () => {
	if (!existsSync(ASSETS)) throw new Error("No build in dist/. Run `bun run build` before `bun run test:e2e`.");
	preview = Bun.spawn(["bunx", "vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await fetch(BASE).then(() => true, () => false)) return;
		await Bun.sleep(250);
	}
	preview.kill();
	throw new Error(`vite preview did not answer on ${BASE} within ${START_TIMEOUT_MS / 1000}s:\n${await new Response(preview.stderr as ReadableStream).text()}`);
}, START_TIMEOUT_MS + 5_000);

afterAll(() => preview?.kill());

async function get(path: string, init?: RequestInit) {
	const response = await fetch(`${BASE}${path}`, init);
	return { status: response.status, type: response.headers.get("content-type") ?? "", cache: response.headers.get("cache-control") ?? "", body: await response.text() };
}

test("app paths serve the SPA without long-lived caching", async () => {
	for (const path of ["/", "/workouts", "/nutrition/history"]) {
		const page = await get(path);
		expect(page.status).toBe(200);
		expect(page.type).toStartWith("text/html");
		expect(page.cache).not.toContain("immutable");
	}
});

test("a missing asset is a 404, never the SPA marked immutable", async () => {
	const missing = await get("/assets/does-not-exist-0000.js");
	expect(missing.status).toBe(404);
	expect(missing.type).not.toStartWith("text/html");
	expect(missing.cache).not.toContain("immutable");
});

test("built assets are immutable", async () => {
	const file = readdirSync(ASSETS).find((name) => name.endsWith(".js"));
	if (file === undefined) throw new Error(`No .js file in ${ASSETS}`);
	const asset = await get(`/assets/${file}`);
	expect(asset.status).toBe(200);
	expect(asset.cache).toContain("immutable");
});

function imagePaths(): string[] {
	const files = ["index.html", "manifest.webmanifest", ...readdirSync(ASSETS).filter((name) => /\.(?:js|css)$/.test(name)).map((name) => `assets/${name}`)];
	const paths = new Set<string>();
	for (const file of files) {
		for (const [, path] of readFileSync(join(CLIENT, file), "utf8").matchAll(IMAGE_PATH)) {
			if (path !== undefined) paths.add(path);
		}
	}
	return [...paths].toSorted();
}

test("the sidebar logo is a built asset", () => {
	expect(imagePaths().filter((path) => /^\/assets\/logo-[\w-]+\.png$/.test(path))).toHaveLength(1);
});

test("every image the build references is served as that image", async () => {
	const paths = imagePaths();
	expect(paths.length).toBeGreaterThan(0);
	for (const path of paths) {
		const response = await fetch(`${BASE}${path}`);
		const bytes = [...new Uint8Array(await response.arrayBuffer())];
		expect({ path, status: response.status, image: (response.headers.get("content-type") ?? "").startsWith("image/") }).toEqual({ path, status: 200, image: true });
		if (path.endsWith(".png")) expect({ path, signature: bytes.slice(0, PNG_SIGNATURE.length) }).toEqual({ path, signature: PNG_SIGNATURE });
	}
});

test("the service worker is never cached", async () => {
	const sw = await get("/sw.js");
	expect(sw.status).toBe(200);
	expect(sw.cache).toBe("no-cache");
});

test("unknown API paths are JSON 404s", async () => {
	const missing = await get("/api/nope");
	expect(missing.status).toBe(404);
	expect(JSON.parse(missing.body)).toEqual({ error: "Not found" });
});

test("bot routes refuse callers without the bot's token", async () => {
	const routes = ["/api/tools/workouts/sync", "/api/tools/nutrition/mcp"];
	for (const path of routes) {
		for (const headers of [{}, { authorization: "Bearer guess" }, { authorization: "guess" }] as Record<string, string>[]) {
			const response = await get(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
			expect({ path, status: response.status }).toEqual({ path, status: 401 });
		}
	}
});
