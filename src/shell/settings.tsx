import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BuildInfo } from "../../scripts/build-info.ts";
import type { DebugReport } from "../../worker/debug.ts";
import type { DebugRow } from "../../worker/tool-debug.ts";
import { Button } from "../kit/button.tsx";
import { toolName } from "../registry.ts";
import { checkHealth, type Health } from "./health.ts";
import { useInstall, type InstallWay } from "./install.ts";
import styles from "./settings.module.css";
import { setTheme, storedTheme, THEMES, type Theme } from "./theme.ts";
import { ToolLayout } from "./tool-layout.tsx";

type Loaded<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed"; error: string };

const LOADING = { state: "loading" } as const;

const THEME_LABELS: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

const SIDES = ["top", "right", "bottom", "left"] as const;

const PADDING = { top: "paddingTop", right: "paddingRight", bottom: "paddingBottom", left: "paddingLeft" } as const;

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isBuildInfo(body: unknown): body is BuildInfo {
	return isObject(body) && isNullableString(body.sha) && isNullableString(body.branch);
}

function isRow(row: unknown): row is DebugRow {
	return isObject(row) && typeof row.label === "string" && typeof row.value === "string";
}

function isDebugReport(body: unknown): body is DebugReport {
	if (!isObject(body) || !isNullableString(body.access) || !Array.isArray(body.tools)) return false;
	const { version } = body;
	return isObject(version) && typeof version.id === "string" && typeof version.deployedAt === "string" && body.tools.every((tool: unknown) => isObject(tool) && typeof tool.slug === "string" && Array.isArray(tool.rows) && tool.rows.every(isRow));
}

function failure(error: unknown): { state: "failed"; error: string } {
	return { state: "failed", error: error instanceof Error ? error.message : "Network error" };
}

async function loadBuild(): Promise<Loaded<BuildInfo | null>> {
	try {
		const response = await fetch("/build.json", { cache: "no-store" });
		if (!response.headers.get("content-type")?.includes("application/json")) return { state: "ready", value: null };
		const body: unknown = await response.json();
		return isBuildInfo(body) ? { state: "ready", value: body } : { state: "failed", error: "Unexpected build.json" };
	} catch (error) {
		return failure(error);
	}
}

async function loadReport(): Promise<Loaded<DebugReport>> {
	try {
		const response = await fetch("/api/debug", { cache: "no-store" });
		const body: unknown = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
		return isDebugReport(body) ? { state: "ready", value: body } : { state: "failed", error: `Unexpected response (HTTP ${response.status})` };
	} catch (error) {
		return failure(error);
	}
}

async function serviceWorkerState(): Promise<string> {
	if (!("serviceWorker" in navigator)) return "Not supported in this browser";
	const registration = await navigator.serviceWorker.getRegistration();
	if (registration === undefined) return "Not registered";
	const state = registration.active === null ? "Installing" : navigator.serviceWorker.controller === null ? "Active, not controlling this page yet" : "Active, controlling this page";
	return registration.waiting === null ? state : `${state}; an update is waiting`;
}

function appState(installed: boolean, way: InstallWay): string {
	if (installed) return "Installed app";
	switch (way) {
		case "prompt":
			return "Browser tab, install prompt ready";
		case "ios":
			return "Browser tab, install from the Share menu";
		case null:
			return "Browser tab, install not offered here";
		default: {
			const never: never = way;
			return never;
		}
	}
}

function healthText(health: Health): string {
	switch (health.state) {
		case "checking":
			return "Checking…";
		case "ok":
			return `Reachable in ${health.latencyMs} ms (connect ${health.connectMs} ms, query ${health.queryMs} ms)`;
		case "down":
			return `Unreachable: ${health.error}`;
		default: {
			const never: never = health;
			return never;
		}
	}
}

function loadedText<T>(loaded: Loaded<T>, text: (value: T) => string): string {
	switch (loaded.state) {
		case "loading":
			return "Checking…";
		case "ready":
			return text(loaded.value);
		case "failed":
			return `Could not load: ${loaded.error}`;
		default: {
			const never: never = loaded;
			return never;
		}
	}
}

function buildText(build: BuildInfo | null): string {
	if (build === null) return "Not recorded on the dev server";
	if (build.sha === null) return "Unknown commit";
	return build.branch === null ? build.sha.slice(0, 7) : `${build.sha.slice(0, 7)} on ${build.branch}`;
}

function useSafeArea(): [ref: (element: HTMLDivElement | null) => void, insets: string] {
	const [element, setElement] = useState<HTMLDivElement | null>(null);
	const [insets, setInsets] = useState("Checking…");
	useEffect(() => {
		if (element === null) return;
		const read = () => {
			const style = getComputedStyle(element);
			setInsets(SIDES.map((side) => `${side} ${Math.round(Number.parseFloat(style[PADDING[side]]))}`).join(", ") + " px");
		};
		read();
		window.addEventListener("resize", read);
		return () => window.removeEventListener("resize", read);
	}, [element]);
	return [setElement, insets];
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className={styles.row}>
			<dt>{label}</dt>
			<dd>{children}</dd>
		</div>
	);
}

function ThemeChoice() {
	const [theme, setChoice] = useState<Theme>(storedTheme);
	return (
		<div role="group" aria-label="Theme" className={styles.choices}>
			{THEMES.map((option) => (
				<Button
					key={option}
					size="sm"
					variant="secondary"
					aria-pressed={theme === option}
					onClick={() => {
						setTheme(option);
						setChoice(option);
					}}
				>
					{THEME_LABELS[option]}
				</Button>
			))}
		</div>
	);
}

export default function Settings() {
	const { installed, way } = useInstall();
	const [probe, insets] = useSafeArea();
	const [build, setBuild] = useState<Loaded<BuildInfo | null>>(LOADING);
	const [report, setReport] = useState<Loaded<DebugReport>>(LOADING);
	const [health, setHealth] = useState<Health>({ state: "checking" });
	const [worker, setWorker] = useState("Checking…");
	const refreshing = useRef(false);

	const refresh = useCallback(() => {
		if (refreshing.current) return;
		refreshing.current = true;
		setHealth({ state: "checking" });
		void Promise.all([loadBuild().then(setBuild), loadReport().then(setReport), checkHealth().then(setHealth), serviceWorkerState().then(setWorker)]).finally(() => {
			refreshing.current = false;
		});
	}, []);

	useEffect(refresh, [refresh]);

	const tools = report.state === "ready" ? report.value.tools.filter((tool) => tool.rows.length > 0) : [];

	return (
		<ToolLayout
			title="Settings"
			actions={
				<Button size="sm" variant="quiet" onClick={refresh}>
					Refresh
				</Button>
			}
		>
			<div className={styles.page}>
				<section className={styles.section} aria-labelledby="settings-appearance">
					<h2 id="settings-appearance" className={styles.heading}>
						Appearance
					</h2>
					<dl className={styles.rows}>
						<Row label="Theme">
							<ThemeChoice />
						</Row>
					</dl>
				</section>
				<section className={styles.section} aria-labelledby="settings-debug">
					<h2 id="settings-debug" className={styles.heading}>
						Debug
					</h2>
					<dl className={styles.rows}>
						<Row label="Build">{loadedText(build, buildText)}</Row>
						<Row label="Deployed">{loadedText(report, ({ version }) => `${dateTime.format(new Date(version.deployedAt))}, version ${version.id.slice(0, 8)}`)}</Row>
						<Row label="Database">{healthText(health)}</Row>
						<Row label="Signed in as">{loadedText(report, ({ access }) => access ?? "No Access identity on this request")}</Row>
						<Row label="Service worker">{worker}</Row>
						<Row label="App">{appState(installed, way)}</Row>
						<Row label="Safe area">{insets}</Row>
					</dl>
					{tools.map((tool) => (
						<div key={tool.slug} className={styles.section}>
							<h3 className={styles.subheading}>{toolName(tool.slug)}</h3>
							<dl className={styles.rows}>
								{tool.rows.map((row, index) => (
									<Row key={`${row.label}-${index}`} label={row.label}>
										{row.value}
									</Row>
								))}
							</dl>
						</div>
					))}
				</section>
				<div ref={probe} className={styles.probe} aria-hidden="true" />
			</div>
		</ToolLayout>
	);
}
