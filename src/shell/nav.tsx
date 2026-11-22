import logo from "../assets/logo.png";
import { IconButton } from "../kit/button.tsx";
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
	SidebarToggle,
} from "../kit/sidebar.tsx";
import { TOOLS } from "../registry.ts";
import { Link, parseRoute, usePath } from "../router.tsx";
import { Icon } from "./icons.tsx";
import { useInstall } from "./install.ts";
import styles from "./shell.module.css";
import { toggleTheme } from "./theme.ts";

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

type NavProps = { onNavigate?: () => void; onClose?: () => void };

export function Nav({ onNavigate, onClose }: NavProps) {
	const route = parseRoute(usePath());
	return (
		<>
			<SidebarHeader>
				<div className={styles.brand}>
					<Link href="/" className={styles.brandLink} onClick={onNavigate}>
						<img src={logo} alt="" width={24} height={24} />
						<span>Tools</span>
					</Link>
					{onClose === undefined ? (
						<SidebarToggle className={styles.brandAction} />
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
							<SidebarMenuButton isActive={route.kind === "home"} render={<Link href="/" onClick={onNavigate} />}>
								<Icon name="home" />
								<span>Home</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarGroup>
				<SidebarGroup>
					<SidebarGroupLabel>Tools</SidebarGroupLabel>
					<SidebarMenu>
						{TOOLS.map((tool) => (
							<SidebarMenuItem key={tool.slug}>
								<SidebarMenuButton isActive={route.kind === "tool" && route.slug === tool.slug} render={<Link href={`/${tool.slug}`} onClick={onNavigate} />}>
									<Icon name={tool.icon ?? "tool"} />
									<span>{tool.name}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter className={styles.foot}>
				<InstallButton />
				<IconButton label="Switch theme" className={styles.theme} onClick={toggleTheme}>
					<Icon name="moon" className={styles.moon} />
					<Icon name="sun" className={styles.sun} />
				</IconButton>
			</SidebarFooter>
		</>
	);
}
