const THEME_KEY = "tools-theme";

export const THEME_COLORS = { light: "#f2f1f0", dark: "#0e0d0c" } as const;

const PINNED_COLOR = "data-pinned";

const SWITCHING = "data-theme-switching";

const SYSTEM_SWITCH = `matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(){var r=document.documentElement;r.setAttribute("${SWITCHING}","");document.body.getBoundingClientRect();r.removeAttribute("${SWITCHING}")})`;

export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t;var m=document.createElement("meta");m.name="theme-color";m.setAttribute("${PINNED_COLOR}","");m.content=t==="dark"?"${THEME_COLORS.dark}":"${THEME_COLORS.light}";document.head.prepend(m)}${SYSTEM_SWITCH}}catch(e){}`;

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function storedTheme(): Theme {
	const stored = localStorage.getItem(THEME_KEY);
	return stored === "light" || stored === "dark" ? stored : "system";
}

function pinThemeColor(theme: Theme): void {
	const pinned = document.head.querySelector(`meta[name="theme-color"][${PINNED_COLOR}]`);
	if (theme === "system") {
		pinned?.remove();
		return;
	}
	const meta = pinned instanceof HTMLMetaElement ? pinned : document.createElement("meta");
	meta.name = "theme-color";
	meta.setAttribute(PINNED_COLOR, "");
	meta.content = THEME_COLORS[theme];
	document.head.insertBefore(meta, document.head.firstChild);
}

function applyTheme(root: HTMLElement, theme: Theme): void {
	if (theme === "system") {
		root.removeAttribute("data-theme");
		localStorage.removeItem(THEME_KEY);
		return;
	}
	root.dataset.theme = theme;
	localStorage.setItem(THEME_KEY, theme);
}

export function setTheme(theme: Theme): void {
	const root = document.documentElement;
	pinThemeColor(theme);
	root.setAttribute(SWITCHING, "");
	applyTheme(root, theme);
	document.body.getBoundingClientRect();
	root.removeAttribute(SWITCHING);
}

export function toggleTheme(): void {
	const current = document.documentElement.dataset.theme ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
	setTheme(current === "dark" ? "light" : "dark");
}
