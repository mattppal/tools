import { useSyncExternalStore, type ComponentProps, type MouseEvent } from "react";

const CHANGED = "tools-navigate";

function subscribe(onChange: () => void): () => void {
	window.addEventListener("popstate", onChange);
	window.addEventListener(CHANGED, onChange);
	return () => {
		window.removeEventListener("popstate", onChange);
		window.removeEventListener(CHANGED, onChange);
	};
}

export function usePath(): string {
	return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function useSearchParam(name: string): string | null {
	const search = useSyncExternalStore(subscribe, () => window.location.search);
	return new URLSearchParams(search).get(name);
}

export function navigate(to: string, { replace = false }: { replace?: boolean } = {}): void {
	if (to === window.location.pathname + window.location.search) return;
	if (replace) window.history.replaceState(null, "", to);
	else window.history.pushState(null, "", to);
	window.dispatchEvent(new Event(CHANGED));
}

export type Route = { kind: "home" } | { kind: "tool"; slug: string; rest: string };

export function parseRoute(path: string): Route {
	const [, slug = "", ...rest] = path.split("/");
	if (slug === "") return { kind: "home" };
	return { kind: "tool", slug, rest: `/${rest.join("/")}` };
}

export function useToolPath(): string {
	const route = parseRoute(usePath());
	return route.kind === "tool" ? route.rest : "/";
}

function plainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
	return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
}

export function Link({ href, onClick, ...props }: ComponentProps<"a"> & { href: string }) {
	return (
		<a
			href={href}
			onClick={(event) => {
				onClick?.(event);
				if (!plainClick(event) || props.target !== undefined) return;
				event.preventDefault();
				navigate(href);
			}}
			{...props}
		/>
	);
}
