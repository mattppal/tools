import type { IconName } from "./shell/icons.tsx";

export type ToolMeta = {
	name: string;
	description: string;
	icon?: IconName;
	order?: number;
	hidden?: boolean;
};

export function defineTool(meta: ToolMeta): ToolMeta {
	return meta;
}
