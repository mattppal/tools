import { createContext, use } from "react";
import type { Layout } from "../kit/layout.ts";

export type ShellState = {
	layout: Layout;
	openNav: () => void;
};

export const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
	const state = use(ShellContext);
	if (state === null) throw new Error("useShell needs the Shell");
	return state;
}
