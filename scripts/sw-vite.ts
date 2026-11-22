import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build, type Plugin } from "vite";

const ROOT = resolve(import.meta.dirname, "..");
const CLIENT_DIR = resolve(ROOT, "dist/client");

async function buildId(): Promise<string> {
	const assets = (await readdir(resolve(CLIENT_DIR, "assets"))).toSorted();
	return createHash("sha256").update(assets.join("\n")).digest("hex").slice(0, 16);
}

async function buildServiceWorker(): Promise<void> {
	await build({
		configFile: false,
		root: ROOT,
		publicDir: false,
		logLevel: "warn",
		define: { TOOLS_BUILD: JSON.stringify(await buildId()) },
		build: {
			outDir: CLIENT_DIR,
			emptyOutDir: false,
			copyPublicDir: false,
			rollupOptions: {
				input: resolve(ROOT, "src/sw/sw.ts"),
				output: { entryFileNames: "sw.js", codeSplitting: false },
			},
		},
	});
}

export function serviceWorker(): Plugin {
	return {
		name: "service-worker",
		apply: "build",
		buildApp: { order: "post", handler: buildServiceWorker },
	};
}
