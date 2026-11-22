import { IconButton } from "../kit/button.tsx";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../kit/tooltip.tsx";
import { TOOLS } from "../registry.ts";
import { Link, parseRoute, usePath } from "../router.tsx";
import { useHealth, type Health } from "./health.ts";
import { Icon } from "./icons.tsx";
import { useInstall } from "./install.ts";
import styles from "./shell.module.css";
import { toggleTheme } from "./theme.ts";

function healthLabel(health: Health): string {
	switch (health.state) {
		case "checking":
			return "Checking database";
		case "ok":
			return `Database connected (${health.latencyMs} ms)`;
		case "down":
			return `Database unreachable: ${health.error}`;
		default: {
			const never: never = health;
			return never;
		}
	}
}

function HealthDot() {
	const health = useHealth();
	const label = healthLabel(health);
	return (
		<Tooltip>
			<TooltipTrigger render={<span className={styles.health} data-state={health.state} role="img" aria-label={label} tabIndex={0} />} />
			<TooltipPopup side="top">{label}</TooltipPopup>
		</Tooltip>
	);
}

function InstallButton() {
	const { way, install } = useInstall();
	if (way !== "prompt") return null;
	return (
		<IconButton label="Install app" onClick={() => void install()}>
			<Icon name="install" />
		</IconButton>
	);
}

type NavProps = { onNavigate?: () => void; onClose?: () => void };

export function Nav({ onNavigate, onClose }: NavProps) {
	const route = parseRoute(usePath());
	return (
		<>
			<SidebarHeader>
				<div className={styles.brand}>
					<Link href="/" className={styles.brandLink} onClick={onNavigate}>
						<img src="/favicon.svg" alt="" width={24} height={24} className={styles.logo} />
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
				<HealthDot />
				<span className={styles.footSpace} />
				<InstallButton />
				<IconButton label="Switch theme" className={styles.theme} onClick={toggleTheme}>
					<Icon name="moon" className={styles.moon} />
					<Icon name="sun" className={styles.sun} />
				</IconButton>
			</SidebarFooter>
		</>
	);
}
