import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { createContext, use, useId, useState, type ReactNode } from "react";
import { cn } from "./utils.ts";
import { usePortalContainer } from "./portal.tsx";

const Described = createContext<string | undefined>(undefined);

export function TooltipProvider({ delay, timeout, children }: { delay: number; timeout?: number; children: ReactNode }) {
	return (
		<BaseTooltip.Provider delay={delay} timeout={timeout}>
			{children}
		</BaseTooltip.Provider>
	);
}

export function Tooltip({ open, defaultOpen = false, onOpenChange, ...props }: BaseTooltip.Root.Props) {
	const id = useId();
	const [own, setOwn] = useState(defaultOpen);
	const shown = open ?? own;
	return (
		<Described value={shown ? id : undefined}>
			<BaseTooltip.Root
				open={shown}
				onOpenChange={(next, details) => {
					setOwn(next);
					onOpenChange?.(next, details);
				}}
				{...props}
			/>
		</Described>
	);
}

export function TooltipTrigger(props: BaseTooltip.Trigger.Props) {
	return <BaseTooltip.Trigger data-slot="tooltip-trigger" aria-describedby={use(Described)} {...props} />;
}

type TooltipPopupProps = Omit<BaseTooltip.Popup.Props, "className"> & {
	className?: string | undefined;
	side?: BaseTooltip.Positioner.Props["side"];
	sideOffset?: number;
	collisionPadding?: number;
};

export function TooltipPopup({ side = "bottom", sideOffset = 8, collisionPadding, className, ...props }: TooltipPopupProps) {
	const id = use(Described);
	return (
		<BaseTooltip.Portal container={usePortalContainer()}>
			<BaseTooltip.Positioner side={side} sideOffset={sideOffset} collisionPadding={collisionPadding} className="z-20" data-floating="">
				<BaseTooltip.Popup
					data-slot="tooltip"
					id={id}
					role="tooltip"
					className={cn("flex items-center gap-1 rounded-sm bg-popover px-2 py-1 text-xs font-ui text-popover-foreground data-open:not-data-instant:animate-fade-in motion-reduce:animate-none", className)}
					{...props}
				/>
			</BaseTooltip.Positioner>
		</BaseTooltip.Portal>
	);
}
