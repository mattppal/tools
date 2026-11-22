import { Input as BaseInput } from "@base-ui/react/input";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils.ts";

export const fieldVariants = cva(
	[
		"edge-surface w-full min-w-0 rounded-control bg-field font-sans font-body text-foreground outline-none placeholder:text-muted-foreground",
		"transition-[background-color] duration-(--duration-hover) ease-[ease]",
		"hover:not-disabled:not-focus:bg-field-focus disabled:opacity-50",
		"aria-invalid:bg-destructive-soft aria-invalid:text-destructive",
	],
	{
		variants: {
			size: {
				sm: "h-control-md px-2 text-xs",
				md: "h-control-lg px-2 text-sm",
			},
		},
		defaultVariants: { size: "md" },
	},
);

export type FieldSize = NonNullable<VariantProps<typeof fieldVariants>["size"]>;

type InputProps = Omit<BaseInput.Props, "className" | "size"> & { className?: string | undefined; size?: FieldSize | undefined };

export function Input({ size, className, ...props }: InputProps) {
	return <BaseInput data-slot="input" className={cn(fieldVariants({ size }), props.type === "time" || props.type === "number" ? "tabular-nums" : null, className)} {...props} />;
}

export const inlineFieldClass = "m-0 min-w-0 bg-transparent p-0 text-inherit [font:inherit] placeholder:text-muted-foreground";

export function InlineInput({ className, ...props }: Omit<BaseInput.Props, "className"> & { className?: string | undefined }) {
	return <BaseInput data-slot="inline-input" className={cn(inlineFieldClass, className)} {...props} />;
}
