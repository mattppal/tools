import { cn } from "../kit/utils.ts";
import { findTool } from "../registry.ts";
import type { Route } from "../router.tsx";
import styles from "./emoji.module.css";

export function routeEmoji(route: Route): string | undefined {
	return route.kind === "tool" ? findTool(route.slug)?.emoji : undefined;
}

export function Emoji({ emoji, size = 16, className }: { emoji: string; size?: 16 | 20 | 24; className?: string | undefined }) {
	return (
		<span data-slot="emoji" className={cn(styles.emoji, className)} style={{ fontSize: size }} aria-hidden="true">
			{emoji}
		</span>
	);
}
