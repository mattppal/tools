import type { SourceKind } from "./types.ts";

type Source = { kind: SourceKind; ref: string | null; label: string };

const PATTERNS: [SourceKind, RegExp][] = [
	["usda_fdc", /^USDA FDC (\d+)\s*(?:\((.*)\))?$/],
	["open_food_facts", /^Open Food Facts (\d+)\s*(?:\((.*)\))?$/],
];

const PREFIXES: Partial<Record<SourceKind, string>> = { usda_fdc: "USDA FDC", open_food_facts: "Open Food Facts" };

export function formatSource(kind: SourceKind, ref: string | null, label: string): string {
	const prefix = PREFIXES[kind];
	if (prefix === undefined || ref === null) return label;
	return label === "" ? `${prefix} ${ref}` : `${prefix} ${ref} (${label})`;
}

export function parseSource(text: string | undefined): Source {
	const trimmed = text?.trim() ?? "";
	for (const [kind, pattern] of PATTERNS) {
		const match = pattern.exec(trimmed);
		if (match?.[1] !== undefined) return { kind, ref: match[1], label: match[2] ?? "" };
	}
	return { kind: "estimate", ref: null, label: trimmed };
}
