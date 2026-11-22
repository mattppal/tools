import { createContext, use } from "react";

const PortalContainer = createContext<HTMLElement | undefined>(undefined);

export const PortalContainerProvider = PortalContainer.Provider;

export function usePortalContainer(): HTMLElement | undefined {
	return use(PortalContainer);
}
