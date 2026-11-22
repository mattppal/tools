import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLayout } from "../kit/layout.ts";
import { Sheet, SheetPopup } from "../kit/sheet.tsx";
import { Sidebar, SidebarProvider } from "../kit/sidebar.tsx";
import { Spinner } from "../kit/spinner.tsx";
import { TooltipProvider } from "../kit/tooltip.tsx";
import { findTool } from "../registry.ts";
import { parseRoute, usePath, type Route } from "../router.tsx";
import { Home } from "./home.tsx";
import { Nav } from "./nav.tsx";
import { NotFound } from "./not-found.tsx";
import { ShellContext, type ShellState } from "./shell-context.ts";
import styles from "./shell.module.css";

const SIDEBAR_KEY = "tools-sidebar";

const Settings = lazy(() => import("./settings.tsx"));

function storedOpen(): boolean {
	return localStorage.getItem(SIDEBAR_KEY) !== "closed";
}

function pageTitle(route: Route): string | undefined {
	switch (route.kind) {
		case "home":
			return undefined;
		case "settings":
			return "Settings";
		case "tool":
			return findTool(route.slug)?.name;
		default: {
			const never: never = route;
			return never;
		}
	}
}

function Loading({ children }: { children: ReactNode }) {
	return (
		<Suspense
			fallback={
				<div className={styles.loading}>
					<Spinner />
				</div>
			}
		>
			{children}
		</Suspense>
	);
}

function ToolPage({ slug }: { slug: string }) {
	const tool = findTool(slug);
	if (tool === undefined) return <NotFound />;
	return (
		<Loading>
			<tool.Component key={tool.slug} />
		</Loading>
	);
}

function Page() {
	const route = parseRoute(usePath());
	const title = pageTitle(route);
	useEffect(() => {
		document.title = title === undefined ? "Tools" : `${title} · Tools`;
	}, [title]);
	switch (route.kind) {
		case "home":
			return <Home />;
		case "settings":
			return (
				<Loading>
					<Settings />
				</Loading>
			);
		case "tool":
			return <ToolPage slug={route.slug} />;
		default: {
			const never: never = route;
			return never;
		}
	}
}

export function Shell() {
	const layout = useLayout();
	const [open, setOpen] = useState(storedOpen);
	const [navOpen, setNavOpen] = useState(false);
	const [sectionsSlot, setSectionsSlot] = useState<HTMLElement | null>(null);
	const compact = layout === "compact";

	const onOpenChange = useCallback((next: boolean) => {
		setOpen(next);
		localStorage.setItem(SIDEBAR_KEY, next ? "open" : "closed");
	}, []);

	useEffect(() => {
		if (!compact) setNavOpen(false);
	}, [compact]);

	const closeNav = useCallback(() => setNavOpen(false), []);
	const state = useMemo<ShellState>(() => ({ layout, openNav: () => setNavOpen(true), closeNav, sectionsSlot }), [layout, closeNav, sectionsSlot]);

	return (
		<SidebarProvider className={styles.app} open={compact ? false : open} onOpenChange={onOpenChange} data-layout={layout}>
			<TooltipProvider delay={600} timeout={300}>
				<ShellContext value={state}>
					{compact ? (
						<Sheet side="left" open={navOpen} onOpenChange={setNavOpen}>
							<SheetPopup side="left" aria-label="Tools" className={styles.navSheet} bodyClassName={styles.navSheetBody}>
								<Nav onNavigate={closeNav} onClose={closeNav} sectionsRef={setSectionsSlot} />
							</SheetPopup>
						</Sheet>
					) : (
						<Sidebar aria-label="Tools" collapsible="icon" className={styles.side}>
							<Nav sectionsRef={setSectionsSlot} />
						</Sidebar>
					)}
					<main className={styles.panel}>
						<Page />
					</main>
				</ShellContext>
			</TooltipProvider>
		</SidebarProvider>
	);
}
