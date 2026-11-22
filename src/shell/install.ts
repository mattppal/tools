import { useSyncExternalStore } from "react";

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

export type InstallWay = "prompt" | "ios" | null;

const STANDALONE = "(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: fullscreen)";
const HANDHELD = "(pointer: coarse)";

const listeners = new Set<() => void>();
let deferred: InstallPrompt | null = null;

function notify(): void {
	for (const listener of listeners) listener();
}

function isInstallPrompt(event: Event): event is InstallPrompt {
	return "prompt" in event && "userChoice" in event;
}

window.addEventListener("beforeinstallprompt", (event) => {
	if (!isInstallPrompt(event)) return;
	event.preventDefault();
	deferred = event;
	notify();
});

window.addEventListener("appinstalled", () => {
	deferred = null;
	notify();
});

function installed(): boolean {
	return window.matchMedia(STANDALONE).matches || ("standalone" in navigator && navigator.standalone === true);
}

function appleTouch(): boolean {
	const agent = navigator.userAgent;
	return /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
}

function currentWay(): InstallWay {
	if (installed() || !window.matchMedia(HANDHELD).matches) return null;
	if (deferred !== null) return "prompt";
	if (appleTouch()) return "ios";
	return null;
}

function subscribe(onChange: () => void): () => void {
	const display = window.matchMedia(STANDALONE);
	listeners.add(onChange);
	display.addEventListener("change", onChange);
	return () => {
		listeners.delete(onChange);
		display.removeEventListener("change", onChange);
	};
}

async function install(): Promise<void> {
	const prompt = deferred;
	if (prompt === null) return;
	deferred = null;
	await prompt.prompt();
	await prompt.userChoice;
	notify();
}

export function useInstall(): { way: InstallWay; installed: boolean; install: () => Promise<void> } {
	return { way: useSyncExternalStore(subscribe, currentWay, () => null), installed: useSyncExternalStore(subscribe, installed, () => false), install };
}
