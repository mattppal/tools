import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { Icon } from "../shell/icons.tsx";
import { buttonVariants, IconButton } from "./button.tsx";
import { Input } from "./input.tsx";
import { ScrollArea } from "./scroll-area.tsx";
import { Skeleton } from "./skeleton.tsx";
import { cn } from "./utils.ts";

type SidebarState = { open: boolean; setOpen: (open: boolean) => void; toggle: () => void };

const SidebarContext = createContext<SidebarState | null>(null);

export function useSidebar(): SidebarState {
	const state = useContext(SidebarContext);
	if (state === null) throw new Error("useSidebar needs a SidebarProvider");
	return state;
}

function isToggleKey(event: KeyboardEvent): boolean {
	return event.key.toLowerCase() === "s" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
}

type SidebarProviderProps = Omit<ComponentProps<"div">, "className"> & {
	className?: string | undefined;
	defaultOpen?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
};

export function SidebarProvider({ defaultOpen = true, open: controlled, onOpenChange, className, children, ...props }: SidebarProviderProps) {
	const [uncontrolled, setUncontrolled] = useState(defaultOpen);
	const open = controlled ?? uncontrolled;
	const setOpen = useCallback(
		(next: boolean) => {
			setUncontrolled(next);
			onOpenChange?.(next);
		},
		[onOpenChange],
	);
	const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!isToggleKey(event)) return;
			event.preventDefault();
			toggle();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [toggle]);
	const state = useMemo(() => ({ open, setOpen, toggle }), [open, setOpen, toggle]);
	return (
		<SidebarContext.Provider value={state}>
			<div data-sidebar-state={open ? "open" : "closed"} className={cn("group/sidebar flex min-h-0 w-full bg-chrome text-chrome-foreground", className)} {...props}>
				{children}
			</div>
		</SidebarContext.Provider>
	);
}

export function Sidebar({ className, children, ...props }: ComponentProps<"aside">) {
	const { open } = useSidebar();
	return (
		<aside
			data-slot="sidebar"
			data-state={open ? "open" : "closed"}
			inert={!open}
			className={cn(
				"h-full w-(--list-width) shrink-0 overflow-hidden transition-[width] duration-(--duration-hover) ease-out motion-reduce:transition-none data-[state=closed]:w-0",
				className,
			)}
			{...props}
		>
			<div className="flex h-full w-(--list-width) flex-col gap-(--sidebar-stack) [--focus-fill:var(--chrome-focus)]">{children}</div>
		</aside>
	);
}

export function SidebarInset({ className, ...props }: ComponentProps<"main">) {
	return (
		<main
			data-slot="sidebar-inset"
			className={cn("edge-raised relative flex min-h-0 min-w-0 flex-1 flex-col rounded-s-xl bg-background text-foreground group-data-[sidebar-state=closed]/sidebar:rounded-none", className)}
			{...props}
		/>
	);
}

export function SidebarToggle({ className }: { className?: string | undefined }) {
	const { open, toggle } = useSidebar();
	return (
		<IconButton label={open ? "Hide sidebar" : "Show sidebar"} aria-keyshortcuts="Meta+S" aria-expanded={open} className={className} onClick={toggle}>
			<Icon name="sidebar" />
		</IconButton>
	);
}

export function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
	return <div data-slot="sidebar-header" className={cn("flex flex-col gap-(--sidebar-stack) px-(--sidebar-inset) pt-(--sidebar-inset)", className)} {...props} />;
}

export function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
	return <div data-slot="sidebar-footer" className={cn("flex items-center justify-between gap-2 px-(--sidebar-inset) pb-(--sidebar-inset)", className)} {...props} />;
}

export function SidebarContent({ className, children, ...props }: ComponentProps<"div">) {
	return (
		<ScrollArea className="min-h-0 flex-1">
			<div data-slot="sidebar-content" className={cn("flex flex-col gap-(--sidebar-group-gap) px-(--sidebar-inset)", className)} {...props}>
				{children}
			</div>
		</ScrollArea>
	);
}

export function SidebarInput({ className, ...props }: ComponentProps<typeof Input>) {
	return <Input type="search" data-sidebar="input" className={cn("bg-chrome-hover hover:not-disabled:not-focus:bg-chrome-selected focus:bg-chrome-selected", className)} {...props} />;
}

export function SidebarGroup({ className, ...props }: ComponentProps<"div">) {
	return <div role="group" data-slot="sidebar-group" className={cn("flex min-w-0 flex-col gap-(--sidebar-row-gap)", className)} {...props} />;
}

export function SidebarGroupLabel({ className, render, ...props }: useRender.ComponentProps<"div">) {
	const defaults = { "data-slot": "sidebar-group-label", className: cn("flex h-control-sm items-center px-(--sidebar-row-x) font-title text-chrome-subtle text-xs", className) };
	return useRender({ defaultTagName: "div", render, props: mergeProps<"div">(defaults, props) });
}

export function SidebarMenu({ className, ...props }: ComponentProps<"ul">) {
	return <ul data-slot="sidebar-menu" className={cn("m-0 flex min-w-0 list-none flex-col gap-(--sidebar-row-gap) p-0", className)} {...props} />;
}

export function SidebarMenuItem({ className, ...props }: ComponentProps<"li">) {
	return <li data-slot="sidebar-menu-item" className={cn("group/menu-item relative min-w-0", className)} {...props} />;
}

const menuButtonVariants = cva(
	[
		"edge-quiet data-active:edge-surface flex w-full min-w-0 rounded-control px-(--sidebar-row-x) text-start font-ui text-chrome-subtle no-underline",
		"transition-[background-color,color] duration-(--duration-hover) ease-[ease]",
		"hover:bg-chrome-hover hover:text-chrome-foreground data-active:bg-chrome-selected data-active:text-chrome-foreground data-popup-open:bg-chrome-selected",
		"aria-disabled:pointer-events-none aria-disabled:opacity-50 disabled:pointer-events-none disabled:opacity-50",
	],
	{
		variants: {
			size: {
				md: "h-control-md items-center gap-2.5 text-sm [&>span:not([data-slot])]:truncate",
				lg: "flex-col items-stretch gap-0.5 py-(--sidebar-row-y) text-sm",
			},
		},
		defaultVariants: { size: "md" },
	},
);

type SidebarMenuButtonProps = useRender.ComponentProps<"button"> & VariantProps<typeof menuButtonVariants> & { isActive?: boolean };

export function SidebarMenuButton({ isActive = false, size, className, render, ...props }: SidebarMenuButtonProps) {
	const current: "page" | undefined = isActive ? "page" : undefined;
	const type: "button" | undefined = render === undefined ? "button" : undefined;
	const defaults = {
		"data-slot": "sidebar-menu-button",
		"data-active": isActive ? "" : undefined,
		"aria-current": current,
		type,
		className: cn(menuButtonVariants({ size }), className),
	};
	return useRender({ defaultTagName: "button", render, props: mergeProps<"button">(defaults, props) });
}

type SidebarMenuActionProps = Omit<ComponentProps<"button">, "children"> & { label: string; children?: ReactNode };

export function SidebarMenuAction({ label, className, children, ...props }: SidebarMenuActionProps) {
	return (
		<button
			data-slot="sidebar-menu-action"
			data-sidebar="menu-action"
			type="button"
			aria-label={label}
			className={cn(
				buttonVariants({ variant: "quiet", size: "sm", icon: true }),
				"absolute end-1 top-1 text-chrome-subtle opacity-0 hover:not-data-disabled:bg-chrome-selected focus-visible:opacity-100 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-popup-open:opacity-100",
				className,
			)}
			{...props}
		>
			{children ?? <Icon name="more" />}
		</button>
	);
}

const YIELDS_TO_ACTION = [
	"transition-opacity duration-(--duration-hover) ease-[ease]",
	"group-hover/menu-item:group-has-[[data-sidebar=menu-action]]/menu-item:opacity-0",
	"group-focus-within/menu-item:group-has-[[data-sidebar=menu-action]]/menu-item:opacity-0",
	"group-has-[[data-sidebar=menu-action][data-popup-open]]/menu-item:opacity-0",
];

export function SidebarMenuBadge({ className, ...props }: ComponentProps<"span">) {
	return <span data-slot="sidebar-menu-badge" className={cn("ms-auto shrink-0 text-chrome-muted text-xs tabular-nums", YIELDS_TO_ACTION, className)} {...props} />;
}

export function SidebarMenuTime({ className, ...props }: ComponentProps<"span">) {
	return <span data-slot="sidebar-menu-time" className={cn("shrink-0 font-body text-chrome-muted text-xs tabular-nums", YIELDS_TO_ACTION, className)} {...props} />;
}

const SKELETON_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-5/6"] as const;

export function SidebarMenuSkeleton({ index = 0 }: { index?: number }) {
	return (
		<div data-slot="sidebar-menu-skeleton" className="flex flex-col gap-1.5 px-(--sidebar-row-x) py-(--sidebar-row-y)">
			<Skeleton className={cn("h-3.5", SKELETON_WIDTHS[index % SKELETON_WIDTHS.length])} />
			<Skeleton className="h-3 w-full" />
		</div>
	);
}
