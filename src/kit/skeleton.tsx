import type { ComponentProps } from "react";
import { cn } from "./utils.ts";

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
	return <div data-slot="skeleton" aria-hidden="true" className={cn("rounded-sm bg-muted animate-pulse motion-reduce:animate-none", className)} {...props} />;
}
