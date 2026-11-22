import { useMediaQuery } from "@base-ui/react/unstable-use-media-query";

export const MEDIUM_QUERY = "(min-width: 768px)";
export const EXPANDED_QUERY = "(min-width: 1024px)";

export type Layout = "compact" | "medium" | "expanded";

export function useLayout(): Layout {
	const medium = useMediaQuery(MEDIUM_QUERY, { defaultMatches: true });
	const expanded = useMediaQuery(EXPANDED_QUERY, { defaultMatches: true });
	if (expanded) return "expanded";
	return medium ? "medium" : "compact";
}
