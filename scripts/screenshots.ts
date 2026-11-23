import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PRODUCTION, serveLiveProxy } from "./live-proxy.ts";
import { isToolsOrigin, waitForSha } from "./smoke.ts";

export type Viewport = { name: string; width: number; height: number; mobile: boolean; scheme: "light" | "dark" };
export type Shot = { name: string; path: string; waitFor?: string[]; clicks?: string[] };

export const VIEWPORTS: Viewport[] = [
	{ name: "desktop", width: 1440, height: 1000, mobile: false, scheme: "light" },
	{ name: "desktop-dark", width: 1440, height: 1000, mobile: false, scheme: "dark" },
	{ name: "mobile", width: 390, height: 844, mobile: true, scheme: "light" },
];

export const SHOTS: Shot[] = [
	{ name: "unified-tdee-{viewport}-summary", path: "/nutrition/weight", clicks: ["90 days"], waitFor: ["kcal a day"] },
	{ name: "unified-tdee-{viewport}-panel", path: "/nutrition/weight", clicks: ["90 days", "kcal a day"] },
	{ name: "nutrition-steps-{viewport}", path: "/nutrition/steps" },
	{ name: "nutrition-history-{viewport}", path: "/nutrition/history" },
	{ name: "workouts-{viewport}", path: "/workouts" },
	{ name: "sleep-{viewport}", path: "/sleep" },
	{ name: "x-posts-live-{viewport}", path: "/x-posts" },
	{ name: "x-posts-{viewport}", path: "/x-posts/queue/review", clicks: ["All"] },
	{ name: "x-posts-queue-{viewport}", path: "/x-posts/queue" },
];

const SCALE = 2;
export const FONT = "Inter";
const START_TIMEOUT_MS = 30_000;
const PAGE_TIMEOUT_MS = 45_000;
const SETTLE_MS = 800;
const CHROME = Bun.which("google-chrome") ?? Bun.which("chromium") ?? "/usr/local/bin/google-chrome";
const READY = `document.readyState === "complete" && document.querySelector("main") !== null && document.querySelector("[aria-busy='true'], [data-slot='skeleton']") === null`;

export function fileName(shot: Shot, viewport: Viewport): string {
	return `${shot.name.replace("{viewport}", viewport.name)}.png`;
}

export function buttonScript(text: string, click: boolean): string {
	return `(() => {
		const button = [...document.querySelectorAll("button")].find((candidate) => (candidate.textContent ?? "").includes(${JSON.stringify(text)}));
		if (button === undefined) return false;
		if (${click} && button.getAttribute("aria-pressed") !== "true") button.click();
		return true;
	})()`;
}

type Message = { id?: number; method?: string; result?: Record<string, unknown>; error?: { message: string } };

async function waitFor(url: string): Promise<Response> {
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const response = await fetch(url).catch(() => null);
		if (response !== null) return response;
		await Bun.sleep(250);
	}
	throw new Error(`${url} did not answer within ${START_TIMEOUT_MS / 1000}s`);
}

async function openChrome(port: number): Promise<{ send: (method: string, params?: object) => Promise<Message>; close: () => void }> {
	const chrome = Bun.spawn([CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=/tmp/screenshots-${port}`, `--remote-debugging-port=${port}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
	const targets = (await (await waitFor(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
	const page = targets.find((target) => target.type === "page");
	if (page === undefined) throw new Error("Chrome opened no page");
	const socket = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
	const pending = new Map<number, (message: Message) => void>();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data)) as Message;
		if (message.id !== undefined) pending.get(message.id)?.(message);
	});
	let nextId = 0;
	const send = (method: string, params: object = {}) =>
		new Promise<Message>((resolve, reject) => {
			const id = ++nextId;
			pending.set(id, (message) => (message.error === undefined ? resolve(message) : reject(new Error(`${method}: ${message.error.message}`))));
			socket.send(JSON.stringify({ id, method, params }));
		});
	return {
		send,
		close: () => {
			socket.close();
			chrome.kill();
		},
	};
}

async function renderedFonts(send: (method: string, params?: object) => Promise<Message>): Promise<string[]> {
	await send("DOM.enable");
	await send("CSS.enable");
	const root = (await send("DOM.getDocument", { depth: 0 })).result?.["root"] as { nodeId: number };
	const { nodeIds } = (await send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "main *" })).result as { nodeIds: number[] };
	const used = new Set<string>();
	for (const nodeId of nodeIds.slice(0, 40)) {
		const reply = await send("CSS.getPlatformFontsForNode", { nodeId }).catch(() => null);
		const fonts = reply?.result?.["fonts"] as { familyName: string }[] | undefined;
		for (const font of fonts ?? []) used.add(font.familyName);
	}
	return [...used];
}

export async function screenshots({ target, token, out, only }: { target: URL; token: { id: string; secret: string }; out: string; only: string | null }): Promise<string[]> {
	const proxy = serveLiveProxy({ port: 0, target, token });
	const base = `http://127.0.0.1:${proxy.port}`;
	const browser = await openChrome(9300 + (process.pid % 500));
	const evaluate = async <T>(expression: string): Promise<T> => {
		const reply = await browser.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		return (reply.result?.["result"] as { value: T }).value;
	};
	const written: string[] = [];
	const failures: string[] = [];
	await mkdir(out, { recursive: true });
	try {
		for (const viewport of VIEWPORTS) {
			await browser.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: SCALE, mobile: viewport.mobile });
			await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: viewport.scheme }] });
			for (const shot of SHOTS) {
				const file = fileName(shot, viewport);
				if (only !== null && !file.includes(only)) continue;
				try {
					await browser.send("Page.navigate", { url: `${base}${shot.path}` });
					const deadline = Date.now() + PAGE_TIMEOUT_MS;
					while (!(await evaluate<boolean>(READY))) {
						if (Date.now() > deadline) throw new Error(`${shot.path} did not finish loading`);
						await Bun.sleep(150);
					}
					const button = async (text: string, click: boolean) => {
						while (!(await evaluate<boolean>(buttonScript(text, click)))) {
							if (Date.now() > deadline) throw new Error(`no button with "${text}" on ${shot.path}`);
							await Bun.sleep(150);
						}
					};
					for (const text of shot.clicks ?? []) {
						await button(text, true);
						await Bun.sleep(SETTLE_MS);
					}
					for (const text of shot.waitFor ?? []) await button(text, false);
					await evaluate("document.fonts.ready.then(() => true)");
					await Bun.sleep(SETTLE_MS);
					const used = await renderedFonts(browser.send);
					if (!used.some((family) => family.startsWith(FONT))) throw new Error(`Chrome rendered ${shot.path} in ${used.join(", ") || "no font"}, not ${FONT}. Install ${FONT} first.`);
					const capture = await browser.send("Page.captureScreenshot", { format: "png" });
					await writeFile(join(out, file), Buffer.from(String(capture.result?.["data"]), "base64"));
					written.push(file);
					console.log(`ok   ${file}`);
				} catch (error) {
					failures.push(file);
					console.log(`FAIL ${file}: ${error instanceof Error ? error.message : error}`);
				}
			}
		}
	} finally {
		browser.close();
		proxy.stop(true);
	}
	if (failures.length > 0) throw new Error(`${failures.length} screenshot(s) failed: ${failures.join(", ")}`);
	return written;
}

if (import.meta.main) {
	const { values } = parseArgs({ options: { target: { type: "string", default: PRODUCTION }, out: { type: "string", default: "screenshots" }, only: { type: "string" }, sha: { type: "string" }, wait: { type: "string", default: "0" } } });
	const id = process.env.CF_ACCESS_CLIENT_ID;
	const secret = process.env.CF_ACCESS_CLIENT_SECRET;
	if (!id || !secret) {
		console.error("screenshots: set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to an Access service token first.");
		process.exit(1);
	}
	if (!isToolsOrigin(values.target)) {
		console.error(`screenshots: ${values.target} is not production or a tools preview, so it doesn't get the Access token.`);
		process.exit(1);
	}
	const target = new URL(values.target);
	try {
		if (values.sha !== undefined) {
			const seen = await waitForSha({ target, token: { id, secret }, sha: values.sha, seconds: Number(values.wait) });
			if (seen !== values.sha) throw new Error(`${target.origin} serves ${seen}, not ${values.sha}, after ${values.wait}s`);
		}
		const written = await screenshots({ target, token: { id, secret }, out: values.out, only: values.only ?? null });
		console.log(`screenshots: wrote ${written.length} PNGs to ${values.out}`);
	} catch (error) {
		console.error(`screenshots: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
}
