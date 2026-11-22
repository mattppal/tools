import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import type { ReactNode } from "react";
import { floatSurface } from "./surface.ts";
import { cn } from "./utils.ts";
import { usePortalContainer } from "./portal.tsx";

export type SheetSide = "left" | "right";

type SheetProps = Omit<DrawerPrimitive.Root.Props, "swipeDirection" | "children"> & { side?: SheetSide; children: ReactNode };

export function Sheet({ side = "right", children, ...props }: SheetProps) {
	return (
		<DrawerPrimitive.Root swipeDirection={side} {...props}>
			{children}
		</DrawerPrimitive.Root>
	);
}

const backdropClass = cn(
	"fixed inset-0 z-30 min-h-dvh bg-overlay opacity-[calc(1-var(--drawer-swipe-progress,0))]",
	"transition-opacity duration-(--duration-sheet) ease-(--ease-drawer) data-starting-style:opacity-0 data-ending-style:opacity-0",
	"data-swiping:duration-0 data-ending-style:duration-[calc(var(--drawer-swipe-strength,1)*var(--duration-sheet-exit))]",
);

const popupClass = cn(
	floatSurface,
	"pointer-events-auto relative flex h-full min-h-0 w-[min(var(--dialog-narrow-width),calc(100vw-var(--space-7)))] flex-col font-sans outline-none will-change-transform [--focus-fill:var(--float-focus)]",
	"[transform:translateX(var(--drawer-swipe-movement-x,0px))] transition-transform duration-(--duration-sheet) ease-(--ease-drawer)",
	"data-swiping:duration-0 data-swiping:select-none data-ending-style:duration-[calc(var(--drawer-swipe-strength,1)*var(--duration-sheet-exit))]",
	"motion-reduce:transition-opacity motion-reduce:data-starting-style:opacity-0 motion-reduce:data-starting-style:[transform:none] motion-reduce:data-ending-style:opacity-0 motion-reduce:data-ending-style:[transform:none]",
);

const sidePopupClass: Record<SheetSide, string> = {
	right: "rounded-s-xl data-starting-style:[transform:translateX(100%)] data-ending-style:[transform:translateX(100%)]",
	left: "rounded-e-xl data-starting-style:[transform:translateX(-100%)] data-ending-style:[transform:translateX(-100%)]",
};

const sideViewportClass: Record<SheetSide, string> = {
	right: "justify-end",
	left: "justify-start",
};

type SheetPopupProps = Omit<DrawerPrimitive.Popup.Props, "className"> & {
	className?: string | undefined;
	bodyClassName?: string | undefined;
	backdrop?: boolean;
	side?: SheetSide;
};

export function SheetPopup({ className, bodyClassName, backdrop = true, side = "right", children, ...props }: SheetPopupProps) {
	return (
		<DrawerPrimitive.Portal container={usePortalContainer()}>
			{backdrop ? <DrawerPrimitive.Backdrop data-slot="sheet-backdrop" className={backdropClass} /> : null}
			<DrawerPrimitive.Viewport data-slot="sheet-viewport" className={cn("pointer-events-none fixed inset-0 z-31 flex items-stretch", sideViewportClass[side])}>
				<DrawerPrimitive.Popup data-slot="sheet-popup" data-side={side} className={cn(popupClass, sidePopupClass[side], className)} {...props}>
					<DrawerPrimitive.Content data-slot="sheet-body" className={cn("min-h-0 flex-auto touch-auto overflow-y-auto overscroll-contain p-4", bodyClassName)}>
						{children}
					</DrawerPrimitive.Content>
				</DrawerPrimitive.Popup>
			</DrawerPrimitive.Viewport>
		</DrawerPrimitive.Portal>
	);
}
