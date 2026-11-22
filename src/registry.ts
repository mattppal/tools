import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { ToolMeta } from "./tool.ts";

export type Tool = ToolMeta & {
	slug: string;
	Component: LazyExoticComponent<ComponentType>;
};

const metas = import.meta.glob<{ default: ToolMeta }>("../tools/*/tool.ts", { eager: true });
const views = import.meta.glob<{ default: ComponentType }>("../tools/*/index.tsx");

function slugOf(file: string): string {
	const slug = file.split("/").at(-2);
	if (slug === undefined) throw new Error(`Cannot read tool slug from ${file}`);
	return slug;
}

function load(slug: string): LazyExoticComponent<ComponentType> {
	const view = views[`../tools/${slug}/index.tsx`];
	if (view === undefined) throw new Error(`tools/${slug} has tool.ts but no index.tsx`);
	return lazy(view);
}

export const TOOLS: readonly Tool[] = Object.entries(metas)
	.map(([file, module]) => {
		const slug = slugOf(file);
		return { ...module.default, slug, Component: load(slug) };
	})
	.filter((tool) => tool.hidden !== true)
	.toSorted((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name));

export function findTool(slug: string): Tool | undefined {
	return TOOLS.find((tool) => tool.slug === slug);
}
