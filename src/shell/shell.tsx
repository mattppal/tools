import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useLayout } from "../kit/layout.ts";
import { Sheet, SheetPopup } from "../kit/sheet.tsx";
import { Sidebar, SidebarProvider } from "../kit/sidebar.tsx";
import { Spinner } from "../kit/spinner.tsx";
import { TooltipProvider } from "../kit/tooltip.tsx";
import { findTool } from "../registry.ts";
import { parseRoute, usePath } from "../router.tsx";
import { Home } from "./home.tsx";
import { Nav } from "./nav.tsx";
import { NotFound } from "./not-found.tsx";
import { ShellContext, type ShellState } from "./shell-context.ts";
import styles from "./shell.module.css";

const SIDEBAR_KEY = "tools-sidebar";

function storedOpen(): boolean {
	return localStorage.getItem(SIDEBAR_KEY) !== "closed";
}

function Page() {
	const route = parseRoute(usePath());
	useEffect(() => {
		const tool = route.kind === "tool" ? findTool(route.slug) : undefined;
		document.title = tool === undefined ? "Tools" : `${tool.name} · Tools`;
	}, [route]);
	if (route.kind === "home") return <Home />;
	const tool = findTool(route.slug);
	if (tool === undefined) return <NotFound />;
	return (
		<Suspense
			fallback={
				<div className={styles.loading}>
					<Spinner />
				</div>
			}
		>
			<tool.Component key={tool.slug} />
		</Suspense>
	);
}

export function Shell() {
	const layout = useLayout();
	const [open, setOpen] = useState(storedOpen);
	const [navOpen, setNavOpen] = useState(false);
	const compact = layout === "compact";

	const onOpenChange = useCallback((next: boolean) => {
		setOpen(next);
		localStorage.setItem(SIDEBAR_KEY, next ? "open" : "closed");
	}, []);

	useEffect(() => {
		if (!compact) setNavOpen(false);
	}, [compact]);

	const state = useMemo<ShellState>(() => ({ layout, openNav: () => setNavOpen(true) }), [layout]);
	const closeNav = useCallback(() => setNavOpen(false), []);

	return (
		<SidebarProvider className={styles.app} open={compact ? false : open} onOpenChange={onOpenChange} data-layout={layout}>
			<TooltipProvider delay={600} timeout={300}>
				<ShellContext value={state}>
					{compact ? (
						<Sheet side="left" open={navOpen} onOpenChange={setNavOpen}>
							<SheetPopup side="left" aria-label="Tools" className={styles.navSheet} bodyClassName={styles.navSheetBody}>
								<Nav onNavigate={closeNav} onClose={closeNav} />
							</SheetPopup>
						</Sheet>
					) : (
						<Sidebar aria-label="Tools" className={styles.side}>
							<Nav />
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
