import type { ReactElement, Ref } from "react";
import logo from "../assets/logo.png";
import { IconButton } from "../kit/button.tsx";
import { Kbd } from "../kit/kbd.tsx";
import { Popover, PopoverPopup, PopoverTrigger } from "../kit/popover.tsx";
import {
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "../kit/sidebar.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../kit/tooltip.tsx";
import { TOOLS } from "../registry.ts";
import { Link, parseRoute, SETTINGS_SLUG, usePath } from "../router.tsx";
import { Icon } from "./icons.tsx";
import { useInstall } from "./install.ts";
import styles from "./shell.module.css";

function InstallButton() {
	const { way, install } = useInstall();
	switch (way) {
		case null:
			return null;
		case "prompt":
			return (
				<IconButton label="Install app" onClick={() => void install()}>
					<Icon name="install" />
				</IconButton>
			);
		case "ios":
			return (
				<Popover>
					<PopoverTrigger
						render={
							<IconButton label="Install app">
								<Icon name="install" />
							</IconButton>
						}
					/>
					<PopoverPopup side="top">Tap Share, then Add to Home Screen.</PopoverPopup>
				</Popover>
			);
		default: {
			const never: never = way;
			return never;
		}
	}
}

function SidebarToggle() {
	const { open, toggle } = useSidebar();
	const label = open ? "Hide sidebar" : "Show sidebar";
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<IconButton label={label} aria-keyshortcuts="Meta+S Control+S" aria-expanded={open} className={styles.brandAction} onClick={toggle}>
						<Icon name="sidebar" />
					</IconButton>
				}
			/>
			<TooltipPopup side={open ? "bottom" : "right"}>
				{label} <Kbd>⌘S</Kbd>
			</TooltipPopup>
		</Tooltip>
	);
}

function RailTip({ label, rail, children }: { label: string; rail: boolean; children: ReactElement }) {
	return (
		<Tooltip disabled={!rail}>
			<TooltipTrigger render={children} />
			<TooltipPopup side="right">{label}</TooltipPopup>
		</Tooltip>
	);
}

type NavProps = { onNavigate?: () => void; onClose?: () => void; sectionsRef: Ref<HTMLDivElement> };

export function Nav({ onNavigate, onClose, sectionsRef }: NavProps) {
	const route = parseRoute(usePath());
	const rail = onClose === undefined && !useSidebar().open;
	return (
		<>
			<SidebarHeader>
				<div className={styles.brand}>
					<Link href="/" className={styles.brandLink} onClick={onNavigate}>
						<img src={logo} alt="" width={24} height={24} />
						<span>Tools</span>
					</Link>
					{onClose === undefined ? (
						<SidebarToggle />
					) : (
						<IconButton label="Close menu" className={styles.brandAction} onClick={onClose}>
							<Icon name="close" />
						</IconButton>
					)}
				</div>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarMenu>
						<SidebarMenuItem>
							<RailTip label="Home" rail={rail}>
								<SidebarMenuButton isActive={route.kind === "home"} className={styles.row} render={<Link href="/" onClick={onNavigate} />}>
									<Icon name="home" />
									<span>Home</span>
								</SidebarMenuButton>
							</RailTip>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarGroup>
				<SidebarGroup>
					<SidebarGroupLabel>Tools</SidebarGroupLabel>
					<SidebarMenu>
						{TOOLS.map((tool) => {
							const active = route.kind === "tool" && route.slug === tool.slug;
							return (
								<SidebarMenuItem key={tool.slug} className={styles.tool}>
									<RailTip label={tool.name} rail={rail}>
										<SidebarMenuButton isActive={active} className={styles.row} render={<Link href={`/${tool.slug}`} onClick={onNavigate} />}>
											<Icon name={tool.icon ?? "tool"} />
											<span>{tool.name}</span>
										</SidebarMenuButton>
									</RailTip>
									{active ? <div ref={sectionsRef} /> : null}
								</SidebarMenuItem>
							);
						})}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter className={styles.foot}>
				<RailTip label="Settings" rail={rail}>
					<SidebarMenuButton isActive={route.kind === "settings"} className={styles.row} render={<Link href={`/${SETTINGS_SLUG}`} onClick={onNavigate} />}>
						<Icon name="gear" />
						<span>Settings</span>
					</SidebarMenuButton>
				</RailTip>
				<InstallButton />
			</SidebarFooter>
		</>
	);
}
