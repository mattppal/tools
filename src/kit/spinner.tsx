import type { ComponentProps } from "react";
import { Icon } from "../shell/icons.tsx";
import { cn } from "./utils.ts";

type SpinnerProps = Omit<ComponentProps<"span">, "children"> & { size?: 12 | 16 | 20 };

export function Spinner({ size = 16, className, ...props }: SpinnerProps) {
	return (
		<span data-slot="spinner" role="status" aria-label="Loading" className={cn("inline-flex shrink-0 animate-spin motion-reduce:animate-none", className)} {...props}>
			<Icon name="loading" size={size} />
		</span>
	);
}
