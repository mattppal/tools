import { Button as BaseButton } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { Spinner } from "./spinner.tsx";
import { cn } from "./utils.ts";

export const buttonVariants = cva(
	[
		"relative inline-flex shrink-0 items-center justify-center justify-self-start gap-1.5 whitespace-nowrap rounded-control font-ui text-foreground no-underline",
		"transition-[scale,background-color,color,opacity] duration-[var(--duration-press),var(--duration-hover),var(--duration-hover),var(--duration-hover)] ease-[var(--ease-out),ease,ease,ease]",
		"active:not-data-disabled:[scale:var(--press-scale)] motion-reduce:active:[scale:none]",
		"data-disabled:cursor-default data-disabled:not-aria-busy:opacity-50 aria-busy:cursor-progress",
	],
	{
		variants: {
			variant: {
				primary: "edge-surface bg-primary font-title text-primary-foreground [--focus-fill:var(--primary-focus)] hover:not-data-disabled:bg-primary-hover data-popup-open:bg-primary-hover",
				secondary: "edge-surface bg-secondary hover:not-data-disabled:bg-field-focus aria-pressed:bg-accent aria-pressed:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground",
				quiet: "bg-transparent text-subtle-foreground hover:not-data-disabled:bg-accent hover:not-data-disabled:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground",
				destructive: "bg-transparent text-destructive [--focus-fill:var(--danger-soft)] hover:not-data-disabled:bg-destructive-soft data-confirming:bg-destructive-soft",
			},
			size: {
				sm: "h-control-md px-2.5 text-xs",
				md: "h-control-lg px-3 text-sm",
			},
			icon: {
				true: "px-0",
				false: "",
			},
		},
		compoundVariants: [
			{ icon: true, size: "sm", className: "w-control-md" },
			{ icon: true, size: "md", className: "w-control-lg" },
		],
		defaultVariants: { variant: "secondary", size: "md", icon: false },
	},
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

type ButtonProps = Omit<BaseButton.Props, "className"> & {
	className?: string | undefined;
	variant?: ButtonVariant | undefined;
	size?: ButtonSize | undefined;
	loading?: boolean | undefined;
};

function Content({ loading, size, children }: { loading: boolean; size: ButtonSize; children: ReactNode }) {
	if (!loading) return children;
	return (
		<>
			<Spinner role={undefined} aria-label={undefined} aria-hidden="true" size={size === "sm" ? 12 : 16} className="absolute" />
			<span data-slot="button-label" className="invisible contents">{children}</span>
		</>
	);
}

export function Button({ variant, size = "md", loading = false, disabled, className, type = "button", children, ...props }: ButtonProps) {
	return (
		<BaseButton
			data-slot="button"
			type={type}
			disabled={disabled === true || loading}
			focusableWhenDisabled={loading}
			aria-busy={loading || undefined}
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		>
			<Content loading={loading} size={size}>
				{children}
			</Content>
		</BaseButton>
	);
}

type IconButtonProps = Omit<ButtonProps, "aria-label" | "children"> & { label: string; children: ReactNode };

export function IconButton({ label, variant = "quiet", size = "md", loading = false, disabled, className, type = "button", children, ...props }: IconButtonProps) {
	return (
		<BaseButton
			data-slot="button"
			type={type}
			aria-label={label}
			disabled={disabled === true || loading}
			focusableWhenDisabled={loading}
			aria-busy={loading || undefined}
			className={cn(buttonVariants({ variant, size, icon: true }), className)}
			{...props}
		>
			<Content loading={loading} size={size}>
				{children}
			</Content>
		</BaseButton>
	);
}
