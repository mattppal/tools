import { useCallback, useSyncExternalStore } from "react";

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

declare global {
	interface Window {
		toolsInstall?: InstallPrompt | null;
	}
}

const CHANGED = "tools-install";

export const INSTALL_SCRIPT = `addEventListener("beforeinstallprompt",function(e){e.preventDefault();window.toolsInstall=e;dispatchEvent(new Event("${CHANGED}"))});addEventListener("appinstalled",function(){window.toolsInstall=null;dispatchEvent(new Event("${CHANGED}"))});`;

export type InstallWay = "prompt" | "mac-safari" | null;

const STANDALONE = "(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: fullscreen)";

function installed(): boolean {
	return window.matchMedia(STANDALONE).matches;
}

function macSafari(): boolean {
	const agent = navigator.userAgent;
	return /Macintosh/.test(agent) && /Version\/[\d.]+.*Safari\//.test(agent) && navigator.maxTouchPoints === 0;
}

function currentWay(): InstallWay {
	if (installed()) return null;
	if (window.toolsInstall) return "prompt";
	if (macSafari()) return "mac-safari";
	return null;
}

function subscribe(onChange: () => void): () => void {
	const display = window.matchMedia(STANDALONE);
	window.addEventListener(CHANGED, onChange);
	display.addEventListener("change", onChange);
	return () => {
		window.removeEventListener(CHANGED, onChange);
		display.removeEventListener("change", onChange);
	};
}

export function useInstall(): { way: InstallWay; install: () => Promise<void> } {
	const way = useSyncExternalStore(subscribe, currentWay, () => null);
	const install = useCallback(async () => {
		const prompt = window.toolsInstall;
		if (!prompt) return;
		window.toolsInstall = null;
		await prompt.prompt();
		await prompt.userChoice;
		window.dispatchEvent(new Event(CHANGED));
	}, []);
	return { way, install };
}
