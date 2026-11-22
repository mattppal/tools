import { useState, type ReactNode } from "react";
import { IconButton } from "../kit/button.tsx";
import { ScrollArea } from "../kit/scroll-area.tsx";
import { Sheet, SheetPopup } from "../kit/sheet.tsx";
import { SidebarToggle, useSidebar } from "../kit/sidebar.tsx";
import { cn } from "../kit/utils.ts";
import { Icon, type IconName } from "./icons.tsx";
import { useShell } from "./shell-context.ts";
import styles from "./tool-layout.module.css";

export type SecondarySidebar = {
	label: string;
	content: ReactNode | ((close: () => void) => ReactNode);
};

export type RightPanel = {
	label: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	content: ReactNode;
	icon?: IconName;
};

type ToolLayoutProps = {
	title: string;
	actions?: ReactNode;
	sidebar?: SecondarySidebar;
	panel?: RightPanel;
	bodyClassName?: string;
	children: ReactNode;
};

function NavButton() {
	const { layout, openNav } = useShell();
	const { open } = useSidebar();
	if (layout === "compact")
		return (
			<IconButton label="Open menu" onClick={openNav}>
				<Icon name="menu" />
			</IconButton>
		);
	return open ? null : <SidebarToggle />;
}

function render(content: SecondarySidebar["content"], close: () => void): ReactNode {
	return typeof content === "function" ? content(close) : content;
}

function Secondary({ sidebar, open, onOpenChange }: { sidebar: SecondarySidebar; open: boolean; onOpenChange: (open: boolean) => void }) {
	const { layout } = useShell();
	const close = () => onOpenChange(false);
	if (layout === "compact")
		return (
			<Sheet side="left" open={open} onOpenChange={onOpenChange}>
				<SheetPopup side="left" aria-label={sidebar.label} className={styles.secondarySheet} bodyClassName={styles.sheetBody}>
					<div className={styles.paneHead}>
						<h2 className={styles.paneTitle}>{sidebar.label}</h2>
						<IconButton label={`Close ${sidebar.label}`} onClick={close}>
							<Icon name="close" />
						</IconButton>
					</div>
					<ScrollArea className={styles.paneScroll}>
						<div className={styles.paneContent}>{render(sidebar.content, close)}</div>
					</ScrollArea>
				</SheetPopup>
			</Sheet>
		);
	return (
		<aside aria-label={sidebar.label} data-state={open ? "open" : "closed"} inert={!open} className={styles.secondary}>
			<div className={styles.secondaryInner}>
				<ScrollArea className={styles.paneScroll}>
					<div className={styles.paneContent}>{render(sidebar.content, () => {})}</div>
				</ScrollArea>
			</div>
		</aside>
	);
}

function Panel({ panel }: { panel: RightPanel }) {
	const { layout } = useShell();
	const close = () => panel.onOpenChange(false);
	const head = (
		<div className={styles.paneHead}>
			<h2 className={styles.paneTitle}>{panel.label}</h2>
			<IconButton label={`Close ${panel.label}`} onClick={close}>
				<Icon name="close" />
			</IconButton>
		</div>
	);
	if (layout === "expanded") {
		if (!panel.open) return null;
		return (
			<aside aria-label={panel.label} className={styles.panel}>
				{head}
				<ScrollArea className={styles.paneScroll}>
					<div className={styles.paneContent}>{panel.content}</div>
				</ScrollArea>
			</aside>
		);
	}
	return (
		<Sheet side="right" open={panel.open} onOpenChange={panel.onOpenChange}>
			<SheetPopup side="right" aria-label={panel.label} className={styles.panelSheet} bodyClassName={styles.sheetBody}>
				{head}
				<ScrollArea className={styles.paneScroll}>
					<div className={styles.paneContent}>{panel.content}</div>
				</ScrollArea>
			</SheetPopup>
		</Sheet>
	);
}

export function ToolLayout({ title, actions, sidebar, panel, bodyClassName, children }: ToolLayoutProps) {
	const { layout } = useShell();
	const [secondaryOpen, setSecondaryOpen] = useState(layout === "expanded");
	return (
		<div className={styles.layout}>
			{sidebar === undefined ? null : <Secondary sidebar={sidebar} open={secondaryOpen} onOpenChange={setSecondaryOpen} />}
			<div className={styles.column}>
				<header className={styles.header}>
					<NavButton />
					{sidebar === undefined ? null : (
						<IconButton
							label={secondaryOpen && layout !== "compact" ? `Hide ${sidebar.label}` : `Show ${sidebar.label}`}
							aria-expanded={secondaryOpen}
							onClick={() => setSecondaryOpen(!secondaryOpen)}
						>
							<Icon name="secondary-sidebar" />
						</IconButton>
					)}
					<h1 className={styles.title}>{title}</h1>
					<div className={styles.actions}>
						{actions}
						{panel === undefined ? null : (
							<IconButton label={panel.open ? `Hide ${panel.label}` : `Show ${panel.label}`} aria-expanded={panel.open} onClick={() => panel.onOpenChange(!panel.open)}>
								<Icon name={panel.icon ?? "panel"} />
							</IconButton>
						)}
					</div>
				</header>
				<div className={cn(styles.body, bodyClassName)} data-scrollbar>
					{children}
				</div>
			</div>
			{panel === undefined ? null : <Panel panel={panel} />}
		</div>
	);
}
