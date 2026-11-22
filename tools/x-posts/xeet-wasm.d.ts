declare module "virtual:xeet" {
	export const packs: Record<string, { url: string; files: { file: string; offset: number; length: number }[] }>;
	export function instantiate(): Promise<void>;
	export function call(op: number, request: string): Uint8Array;
	export function missing_packs(request: string): string;
	export function register_font(file: string, bytes: Uint8Array): void;
	export function upstream_version(): string;
}
