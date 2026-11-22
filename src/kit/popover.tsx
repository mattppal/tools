import { Popover as BasePopover } from "@base-ui/react/popover";
import { usePortalContainer } from "./portal.tsx";
import { anchoredSurface, popupMotion, positionerClass } from "./surface.ts";
import { cn } from "./utils.ts";

export const Popover = BasePopover.Root;

export function PopoverTrigger(props: BasePopover.Trigger.Props) {
	return <BasePopover.Trigger data-slot="popover-trigger" {...props} />;
}

type PopoverPopupProps = Omit<BasePopover.Popup.Props, "className"> & {
	className?: string | undefined;
	side?: BasePopover.Positioner.Props["side"];
	sideOffset?: number;
};

export function PopoverPopup({ side = "bottom", sideOffset = 8, className, ...props }: PopoverPopupProps) {
	return (
		<BasePopover.Portal container={usePortalContainer()}>
			<BasePopover.Positioner side={side} sideOffset={sideOffset} collisionPadding={8} className={positionerClass} data-floating="">
				<BasePopover.Popup data-slot="popover" className={cn(anchoredSurface, popupMotion, "max-w-64 text-sm font-ui outline-none", className)} {...props} />
			</BasePopover.Positioner>
		</BasePopover.Portal>
	);
}
