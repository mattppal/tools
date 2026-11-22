const THEME_KEY = "tools-theme";

const THEME_COLORS = {
	light: { compact: "#f4f3f1", wide: "#e8e6e4" },
	dark: { compact: "#1a1917", wide: "#0e0d0c" },
} as const;

const COMPACT_MEDIA = "(max-width: 767px)";

const PINNED_COLOR = "data-pinned";

const SWITCHING = "data-theme-switching";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function storedTheme(): Theme {
	const stored = localStorage.getItem(THEME_KEY);
	return stored === "light" || stored === "dark" ? stored : "system";
}

function themeColorMeta(content: string, media?: string): HTMLMetaElement {
	const meta = document.createElement("meta");
	meta.name = "theme-color";
	meta.setAttribute(PINNED_COLOR, "");
	if (media !== undefined) meta.media = media;
	meta.content = content;
	return meta;
}

function pinThemeColor(theme: Theme): void {
	for (const pinned of document.head.querySelectorAll(`meta[name="theme-color"][${PINNED_COLOR}]`)) pinned.remove();
	if (theme === "system") return;
	const colors = THEME_COLORS[theme];
	const wide = document.head.insertBefore(themeColorMeta(colors.wide), document.head.firstChild);
	document.head.insertBefore(themeColorMeta(colors.compact, COMPACT_MEDIA), wide);
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
