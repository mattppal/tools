import type { ComponentProps } from "react";
import { cn } from "./utils.ts";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
	return <kbd data-slot="kbd" className={cn("inline-flex items-center text-xs font-ui text-muted-foreground tabular-nums", className)} {...props} />;
}
