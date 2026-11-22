import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

const ID = "virtual:xeet";
const RESOLVED_ID = `\0${ID}`;
const WASM_DIR = join(dirname(createRequire(import.meta.url).resolve("@xeet/core")), "..", "wasm");
const NODE_TAIL = /const wasmPath = [^\n]*\nconst wasmBytes = [^\n]*\nconst wasmModule = [^\n]*\nlet wasmInstance = [^\n]*\nlet wasm = wasmInstance\.exports;\nwasm\.__wbindgen_start\(\);\s*$/;
const ASSET_FILE_LIMIT = 25 * 1024 * 1024;

type PackManifest = { version: number; packs: Record<string, { bytes: number; files: { file: string; offset: number; length: number }[] }> };

export async function xeetModule(): Promise<string> {
	const glue = await readFile(join(WASM_DIR, "xeet_wasm.js"), "utf8");
	if (!NODE_TAIL.test(glue)) throw new Error("@xeet/core's wasm glue no longer ends with the Node loader xeet-vite.ts replaces");
	const manifest = JSON.parse(await readFile(join(WASM_DIR, "fonts", "packs.json"), "utf8")) as PackManifest;
	if (manifest.version !== 1) throw new Error(`@xeet/core packs.json version ${manifest.version} is not 1`);
	const packs = Object.entries(manifest.packs).filter(([, pack]) => pack.bytes <= ASSET_FILE_LIMIT);
	const imports = [`import wasmUrl from ${JSON.stringify(`${join(WASM_DIR, "xeet_wasm_bg.wasm")}?url`)};`, ...packs.map(([name], index) => `import pack${index} from ${JSON.stringify(`${join(WASM_DIR, "fonts", `${name}.bin`)}?url`)};`)];
	const table = packs.map(([name, pack], index) => `${JSON.stringify(name)}: { url: pack${index}, files: ${JSON.stringify(pack.files.map(({ file, offset, length }) => ({ file, offset, length })))} }`);
	return [
		...imports,
		glue.replace(NODE_TAIL, "let wasm;\n").replace(/^exports\.\w+ = \w+;$/gm, ""),
		`export const packs = { ${table.join(", ")} };`,
		"export async function instantiate() {",
		"\tconst response = await fetch(wasmUrl);",
		"\tif (!response.ok) throw new Error(`xeet wasm answered ${response.status}`);",
		"\tconst { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), __wbg_get_imports());",
		"\twasm = instance.exports;",
		"\twasm.__wbindgen_start();",
		"}",
		"export { call, missing_packs, register_font, upstream_version };",
	].join("\n");
}

export function xeet(): Plugin {
	return {
		name: "xeet",
		resolveId: (id) => (id === ID ? RESOLVED_ID : undefined),
		load: (id) => (id === RESOLVED_ID ? xeetModule() : undefined),
	};
}
