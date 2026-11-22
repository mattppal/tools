import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const merge = extendTailwindMerge({
	extend: {
		theme: {
			text: ["md", "display"],
			radius: ["control"],
			"font-weight": ["body", "ui", "title"],
			spacing: ["control-sm", "control-md", "control-lg"],
		},
	},
});

export function cn(...inputs: ClassValue[]): string {
	return merge(clsx(inputs));
}
