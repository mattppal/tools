import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import type { ReactElement } from "react";
import { cn } from "./utils.ts";

export function scrollFadeMargin(node: Element): { top: number; right: number; bottom: number; left: number } {
	const style = getComputedStyle(node);
	return { top: Number.parseFloat(style.getPropertyValue("--scroll-mask-top")), right: 0, bottom: Number.parseFloat(style.getPropertyValue("--scroll-mask-bottom")), left: 0 };
}

type ScrollAreaProps = Omit<ScrollAreaPrimitive.Root.Props, "className" | "children"> & {
	className?: string | undefined;
	viewport?: ReactElement | undefined;
	fade?: boolean;
	scrollbar?: boolean;
	children: ReactElement;
};

export function ScrollArea({ className, viewport, fade = true, scrollbar = true, children, ...props }: ScrollAreaProps) {
	return (
		<ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn("relative grid min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]", className)} {...props}>
			<ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className={cn("col-start-1 row-start-1 min-h-0 overscroll-contain", fade && "scroll-fade")} render={viewport}>
				<ScrollAreaPrimitive.Content role={undefined} render={children} />
			</ScrollAreaPrimitive.Viewport>
			{scrollbar ? (
				<ScrollAreaPrimitive.Scrollbar data-slot="scroll-area-scrollbar" orientation="vertical" className="m-0.5 flex w-1.5 opacity-0 transition-opacity data-hovering:opacity-100 data-scrolling:opacity-100">
					<ScrollAreaPrimitive.Thumb data-slot="scroll-area-thumb" className="w-full rounded-full bg-scrollbar hover:bg-scrollbar-hover active:bg-scrollbar-active" />
				</ScrollAreaPrimitive.Scrollbar>
			) : null}
		</ScrollAreaPrimitive.Root>
	);
}
