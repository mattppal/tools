export const floatSurface = "edge-overlay bg-popover text-popover-foreground [--hover-bg:var(--float-hover)] [--focus-bg:var(--float-focus)]";

export const popupMotion =
	"origin-(--transform-origin) data-open:animate-pop-in data-closed:animate-pop-out data-instant:animate-none motion-reduce:data-open:animate-overlay-in motion-reduce:data-closed:animate-overlay-out";

export const anchoredSurface = `${floatSurface} rounded-panel p-pane-inset`;

export const listSurface = `${anchoredSurface} ${popupMotion} min-w-(--menu-width) max-h-(--available-height) overflow-y-auto overscroll-contain`;

export const itemClass =
	"flex h-control-lg cursor-default select-none items-center gap-2 rounded-pane px-3 text-sm font-ui text-foreground no-underline data-highlighted:bg-accent data-disabled:text-muted-foreground";

export const groupLabelClass = "px-3 pt-2 pb-1 text-xs text-muted-foreground";

export type ItemTone = "default" | "destructive";

export const itemTones: Record<ItemTone, string> = {
	default: "",
	destructive: "text-destructive data-highlighted:bg-destructive-soft [&>svg]:text-current",
};

export const itemIconClass = "shrink-0 text-muted-foreground";

export const itemLabelClass = "min-w-0 truncate";

export const itemDetailClass = "ms-auto min-w-0 max-w-56 truncate ps-4 text-xs text-muted-foreground tabular-nums";

export const itemIndicatorClass = "ms-auto inline-flex [[data-slot$=item-detail]~&]:ms-2 [[data-slot$=shortcut]~&]:ms-2";

export const shortcutClass = "ms-auto ps-4 text-xs font-ui text-muted-foreground tabular-nums [[data-slot$=item-detail]~&]:ms-0 [[data-slot$=item-detail]~&]:ps-3";

export const inputClass = "h-full min-w-0 flex-1 bg-transparent p-0 font-body text-foreground placeholder:text-muted-foreground";

export const positionerClass = "z-34";
