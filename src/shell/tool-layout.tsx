import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { Button, IconButton } from "../kit/button.tsx";
import { Kbd } from "../kit/kbd.tsx";
import { ScrollArea } from "../kit/scroll-area.tsx";
import { Sheet, SheetPopup } from "../kit/sheet.tsx";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../kit/sidebar.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../kit/tooltip.tsx";
import { cn } from "../kit/utils.ts";
import { Link, parseRoute, usePath } from "../router.tsx";
import { Emoji, routeEmoji } from "./emoji.tsx";
import { Icon } from "./icons.tsx";
import { useShell } from "./shell-context.ts";
import styles from "./tool-layout.module.css";

export type ToolSection = { label: string; path: string };

export type ToolPanel = { label: string; content: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void };

type ToolLayoutProps = {
	title: string;
	actions?: ReactNode;
	sections?: readonly ToolSection[];
	panel?: ToolPanel | undefined;
	bodyClassName?: string;
	children: ReactNode;
};

const PANEL_KEYS = "⌥⌘P";
const PANEL_ARIA_KEYS = "Meta+Alt+P Control+Alt+P";

function isPanelKey(event: KeyboardEvent): boolean {
	return event.code === "KeyP" && (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && !event.repeat && !event.getModifierState("AltGraph");
}

function isCurrent(rest: string, path: string): boolean {
	return rest === path || (path !== "/" && rest.startsWith(`${path}/`));
}

function Sections({ sections }: { sections: readonly ToolSection[] }) {
	const { closeNav } = useShell();
	const route = parseRoute(usePath());
	if (route.kind !== "tool") return null;
	return (
		<SidebarMenu aria-label="Sections" className={styles.sections}>
			{sections.map((section) => (
				<SidebarMenuItem key={section.path}>
					<SidebarMenuButton
						isActive={isCurrent(route.rest, section.path)}
						render={<Link href={section.path === "/" ? `/${route.slug}` : `/${route.slug}${section.path}`} onClick={closeNav} />}
					>
						<span>{section.label}</span>
					</SidebarMenuButton>
				</SidebarMenuItem>
			))}
		</SidebarMenu>
	);
}

function PanelHead({ label, onClose }: { label: string; onClose: () => void }) {
	return (
		<div className={styles.paneHead}>
			<h2 className={styles.paneTitle}>{label}</h2>
			<IconButton label={`Close ${label}`} aria-keyshortcuts={PANEL_ARIA_KEYS} onClick={onClose}>
				<Icon name="close" />
			</IconButton>
		</div>
	);
}

export function ToolLayout({ title, actions, sections, panel, bodyClassName, children }: ToolLayoutProps) {
	const { layout, openNav, sectionsSlot } = useShell();
	const emoji = routeEmoji(parseRoute(usePath()));
	const [ownOpen, setOwnOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const docked = useRef<HTMLElement>(null);
	const hasPanel = panel !== undefined;
	const isDocked = layout === "expanded";
	const panelOpen = panel?.open ?? ownOpen;

	const setPanelOpen = (next: boolean) => {
		setOwnOpen(next);
		panel?.onOpenChange?.(next);
	};

	const showPanel = (next: boolean) => {
		const hadFocus = docked.current?.contains(document.activeElement) ?? false;
		flushSync(() => setPanelOpen(next));
		if (next) docked.current?.focus();
		else if (hadFocus) trigger.current?.focus();
	};

	useEffect(() => {
		if (!hasPanel) return;
		const onKey = (event: KeyboardEvent) => {
			if (!isPanelKey(event)) return;
			event.preventDefault();
			showPanel(!panelOpen);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [hasPanel, panelOpen]);

	return (
		<div className={styles.layout}>
			<div className={styles.column}>
				<header className={styles.header}>
					{layout === "compact" ? (
						<IconButton label="Open menu" onClick={openNav}>
							<Icon name="menu" />
						</IconButton>
					) : null}
					<h1 className={styles.title}>
						{emoji === undefined ? null : <Emoji emoji={emoji} />}
						<span className={styles.titleText}>{title}</span>
					</h1>
					<div className={styles.actions}>
						{actions}
						{!hasPanel || (isDocked && panelOpen) ? null : (
							<Tooltip>
								<TooltipTrigger
									render={
										<Button ref={trigger} variant="quiet" size="sm" aria-expanded={panelOpen} aria-keyshortcuts={PANEL_ARIA_KEYS} onClick={() => showPanel(true)}>
											{panel.label}
										</Button>
									}
								/>
								<TooltipPopup>
									{panel.label} <Kbd>{PANEL_KEYS}</Kbd>
								</TooltipPopup>
							</Tooltip>
						)}
					</div>
				</header>
				<div className={cn(styles.body, bodyClassName)} data-scrollbar>
					{children}
				</div>
			</div>
			{!hasPanel ? null : isDocked ? (
				panelOpen ? (
					<aside ref={docked} tabIndex={-1} aria-label={panel.label} className={styles.panel}>
						<PanelHead label={panel.label} onClose={() => showPanel(false)} />
						<ScrollArea className={styles.paneScroll}>
							<div className={styles.paneContent}>{panel.content}</div>
						</ScrollArea>
					</aside>
				) : null
			) : (
				<Sheet side="right" open={panelOpen} onOpenChange={setPanelOpen}>
					<SheetPopup side="right" aria-label={panel.label} className={styles.panelSheet} bodyClassName={styles.sheetBody}>
						<PanelHead label={panel.label} onClose={() => setPanelOpen(false)} />
						<ScrollArea className={styles.paneScroll}>
							<div className={styles.paneContent}>{panel.content}</div>
						</ScrollArea>
					</SheetPopup>
				</Sheet>
			)}
			{sections === undefined || sectionsSlot === null ? null : createPortal(<Sections sections={sections} />, sectionsSlot)}
		</div>
	);
}
