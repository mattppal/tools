const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const TIME_ZONE = "America/Los_Angeles";

export function isIsoDate(value: string): boolean {
	return ISO_DATE.test(value) && Number.isFinite(dayNumber(value)) && isoDate(dayNumber(value)) === value;
}

export function dayNumber(date: string): number {
	return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

export function isoDate(day: number): string {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
	return isoDate(dayNumber(date) + days);
}

const CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" });

export function clockTime(instant: string): string {
	return CLOCK.format(new Date(instant));
}

export function today(now = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
