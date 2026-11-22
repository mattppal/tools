import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import type { ExpenditureView } from "../tools/nutrition/store.ts";
import { type DayView, type HistoryDay, macroProgress, type StepsRow, type Targets, type WeightRow } from "../tools/nutrition/types.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 4900 + (process.pid % 600);
const DEBUG_PORT = 9900 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const START_TIMEOUT_MS = 30_000;
const PAGE_TIMEOUT_MS = 10_000;
const PHONE_WIDTHS = [360, 390];
const PAGES = ["/nutrition", "/nutrition/history", "/nutrition/weight", "/nutrition/steps", "/nutrition/steps?group=week", "/nutrition/steps?group=month", "/workouts"];
const CHROME = Bun.which("google-chrome") ?? Bun.which("chromium") ?? "/usr/local/bin/google-chrome";

const isoDay = (offset: number) => new Date(Date.UTC(2026, 10, 22) + offset * 86_400_000).toISOString().slice(0, 10);
const days = (count: number) => Array.from({ length: count }, (_, index) => isoDay(index - count + 1));

const targets: Targets = {
	effectiveFrom: "2026-11-01",
	notes: "",
	kcal: { min: 2600, max: 2900 },
	protein_g: { min: 170, max: 200 },
	fat_g: { min: 55, max: 70 },
	carbs_g: { min: 330, max: 380 },
	stepsTarget: 10000,
};
const totals = { kcal: 2_412, protein_g: 188, carbs_g: 301, fat_g: 66, fiber_g: 31 };
const day: DayView = {
	date: isoDay(0),
	closed: false,
	estimated: true,
	phase: "maintain",
	entries: [],
	totals,
	targets,
	progress: macroProgress(totals, targets),
	checkIn: { bodyweightLb: 180.6, steps: 16_459, bloatScore: 3, energy: 7, sleep: 8, stress: 4, notes: "A long note about the day that has to wrap on a phone screen without pushing anything sideways." },
};
const history: HistoryDay[] = days(30).map((date, index) => {
	const kcal = index % 7 === 0 ? 1_100 : 2_400 + index * 20;
	return { date, closed: index < 29, entries: 14, kcalTarget: 2750, kcalRange: { min: 2600, max: 2900 }, partial: kcal < 1_375, steps: 10_000 + index * 517, kcal, protein_g: 190, carbs_g: 320, fat_g: 66 };
});
const weights: WeightRow[] = days(120).map((date, index) => ({ date, weight: 180 + Math.sin(index / 9), rolling7d: 180.2, rolling14d: 180.3, rolling28d: 180.4, source: "withings" }));
const steps: StepsRow[] = days(120).map((date, index) => ({ date, steps: 8_000 + ((index * 3_331) % 14_000), rolling7d: 12_345, rolling14d: 12_100, rolling28d: 11_900, target: 10_000 }));
const spentDays = days(90).map((date, index) => ({
	date,
	total: 2_780 + (index % 7) * 40,
	bmr: 1_610,
	bmrMethod: "mifflin" as const,
	living: 242,
	steps: 550,
	stepCount: index % 11 === 0 ? null : 12_778,
	stepsEstimated: index % 11 === 0,
	stepsFrom: index % 11 === 0 ? ("median" as const) : ("count" as const),
	training: index % 3 === 0 ? 160 : 0,
	sessions: index % 3 === 0 ? [{ name: "C W4 Day 3 Deadlift with a long session name", kcal: 160, source: "estimate" as const }] : [],
	tef: 278,
	intake: index % 5 === 0 ? 2_750 : null,
	trendLb: 180.2,
}));
const expenditure: ExpenditureView = {
	tdee: 2_779,
	plusMinus: 90,
	basis: "calibrated",
	loggedDays: 14,
	measured: { tdee: 2_812, plusMinus: 120, loggedDays: 14, from: isoDay(-20), to: isoDay(-7) },
	scale: {
		value: 0.915,
		sd: 0.032,
		windows: [
			{ kind: "logged", source: "Cronometer", from: "2019-12-01", to: "2019-12-19", days: 17, tdee: 1_832, plusMinus: 310, scale: 0.687, weight: 0.02 },
			{ kind: "logged", source: "Cronometer", from: "2020-01-10", to: "2020-02-06", days: 27, tdee: 2_191, plusMinus: 230, scale: 0.825, weight: 0.02 },
			{ kind: "logged", source: "logged", from: "2026-10-06", to: "2026-10-13", days: 8, tdee: 2_724, plusMinus: 560, scale: 0.856, weight: 0.03 },
			{ kind: "tracker", source: "tracker", from: "2026-10-06", to: "2026-11-13", days: 8, tdee: 2_869, plusMinus: 100, scale: 0.906, weight: 0.83 },
		],
	},
	components: { bmr: 1_610, living: 242, steps: 550, training: 100, tef: 278 },
	days: spentDays,
	minDays: 14,
	avgSteps: 13_205,
	stepDays: 61,
};

const FIXTURES: Record<string, unknown> = {
	"/api/tools/nutrition/day": day,
	"/api/tools/nutrition/history": history,
	"/api/tools/nutrition/weights": weights,
	"/api/tools/nutrition/steps": steps,
	"/api/tools/nutrition/expenditure": expenditure,
	"/api/tools/nutrition/phase": null,
};

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };

let preview: Subprocess;
let chrome: Subprocess;
let socket: WebSocket;
let nextId = 0;
const pending = new Map<number, (message: Message) => void>();

function send(method: string, params: object = {}): Promise<Message> {
	const id = ++nextId;
	return new Promise((resolve) => {
		pending.set(id, resolve);
		socket.send(JSON.stringify({ id, method, params }));
	});
}

async function evaluate<T>(expression: string): Promise<T> {
	const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	return (reply.result?.["result"] as { value: T }).value;
}

async function waitFor(url: string, timeoutMs: number): Promise<Response> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = await fetch(url).catch(() => null);
		if (response !== null) return response;
		await Bun.sleep(250);
	}
	throw new Error(`${url} did not answer within ${timeoutMs / 1000}s`);
}

beforeAll(async () => {
	if (!existsSync(join(ROOT, "dist/client/assets"))) throw new Error("No build in dist/. Run `bun run build` before `bun run test:e2e`.");
	preview = Bun.spawn(["bunx", "vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
	chrome = Bun.spawn([CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=/tmp/overflow-${DEBUG_PORT}`, `--remote-debugging-port=${DEBUG_PORT}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
	await waitFor(BASE, START_TIMEOUT_MS);
	const targets = (await (await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json`, START_TIMEOUT_MS)).json()) as { type: string; webSocketDebuggerUrl: string }[];
	const page = targets.find((target) => target.type === "page");
	if (page === undefined) throw new Error("Chrome opened no page");
	socket = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data)) as Message;
		if (message.id !== undefined) pending.get(message.id)?.(message);
		if (message.method !== "Fetch.requestPaused") return;
		const { requestId, request } = message.params as { requestId: string; request: { url: string } };
		const path = new URL(request.url).pathname;
		if (!(path in FIXTURES)) return void send("Fetch.continueRequest", { requestId });
		const body = Buffer.from(JSON.stringify(FIXTURES[path])).toString("base64");
		void send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body });
	});
	await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/tools/*" }] });
}, START_TIMEOUT_MS * 2 + 5_000);

afterAll(() => {
	socket?.close();
	chrome?.kill();
	preview?.kill();
});

const MEASURE = `(() => {
	const overflows = [];
	const page = document.documentElement.scrollWidth - window.innerWidth;
	if (page > 1) overflows.push("page scrolls sideways by " + page + "px");
	for (const cell of document.querySelectorAll("main dl > div")) {
		const box = cell.getBoundingClientRect();
		for (const part of cell.children) {
			const rect = part.getBoundingClientRect();
			if (rect.right > box.right + 1 || part.scrollWidth > part.clientWidth + 1) overflows.push(JSON.stringify(part.textContent) + " runs out of its cell");
		}
	}
	return overflows;
})()`;

for (const width of PHONE_WIDTHS) {
	for (const path of PAGES) {
		test(`${path} fits a ${width}px phone`, async () => {
			await send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: true });
			await send("Page.navigate", { url: `${BASE}${path}` });
			const deadline = Date.now() + PAGE_TIMEOUT_MS;
			while (Date.now() < deadline && !(await evaluate<boolean>(`document.readyState === "complete" && document.querySelector("main") !== null && document.querySelector("[aria-busy='true'], [data-slot='skeleton']") === null`))) await Bun.sleep(100);
			await Bun.sleep(300);
			expect(await evaluate<string[]>(MEASURE)).toEqual([]);
		});
	}
}
