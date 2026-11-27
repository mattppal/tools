export class BadRequest extends Error {}

export class Conflict extends Error {}

export class NotFound extends Error {}

export function iso(value: Date | string): string {
	return (value instanceof Date ? value : new Date(value)).toISOString().replace(/\.000Z$/, "Z");
}

export function monthOf(at: Date): string {
	return at.toISOString().slice(0, 7);
}

export function postUrl(handle: string, id: string): string {
	return handle === "unknown" ? `https://x.com/i/status/${id}` : `https://x.com/${handle}/status/${id}`;
}
