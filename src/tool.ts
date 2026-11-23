export type ToolMeta = {
	name: string;
	description: string;
	emoji: string;
	order?: number;
	hidden?: boolean;
};

export function defineTool(meta: ToolMeta): ToolMeta {
	return meta;
}
