export const AREAS = ["fitness", "relationships", "career", "content", "finance", "life-quality", "systems", "inner"] as const;
export const STATUSES = ["active", "achieved", "partial", "missed", "dropped", "unknown"] as const;
export const HORIZONS = ["year", "quarter"] as const;
export const SOURCES = ["matt", "gtd-bot"] as const;

export type Area = (typeof AREAS)[number];
export type Status = (typeof STATUSES)[number];
export type Horizon = (typeof HORIZONS)[number];
export type Quarter = 1 | 2 | 3 | 4;
export type Source = (typeof SOURCES)[number];

export const AREA_LABELS: Record<Area, string> = {
	fitness: "Fitness",
	relationships: "Relationships",
	career: "Career",
	content: "Content",
	finance: "Finance",
	"life-quality": "Life quality",
	systems: "Systems",
	inner: "Inner",
};

export const STATUS_LABELS: Record<Status, string> = {
	active: "Active",
	achieved: "Achieved",
	partial: "Partial",
	missed: "Missed",
	dropped: "Dropped",
	unknown: "Status unknown",
};

export const TIME_ZONE = "America/Los_Angeles";

export function today(now = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type Checkin = {
	id: string;
	goalId: string;
	clientKey: string;
	date: string;
	note: string;
	progress: number | null;
	statusAtCheckin: Status;
	source: Source;
	createdAt: string;
};

export type Goal = {
	id: string;
	year: number;
	horizon: Horizon;
	quarter: Quarter | null;
	area: Area;
	title: string;
	description: string;
	metric: string | null;
	target: string | null;
	status: Status;
	parentId: string | null;
	sourceUrl: string | null;
	todoistProjectId: string | null;
	todoistTaskIds: string[];
	createdAt: string;
	updatedAt: string;
	latestCheckin: Checkin | null;
};

export type GoalYear = { year: number; northStar: string };

export type YearView = GoalYear & { goals: Goal[] };

export type Overview = { years: GoalYear[]; goals: Goal[] };

export function compareGoals(a: Goal, b: Goal): number {
	return b.year - a.year || AREAS.indexOf(a.area) - AREAS.indexOf(b.area) || HORIZONS.indexOf(a.horizon) - HORIZONS.indexOf(b.horizon) || (a.quarter ?? 0) - (b.quarter ?? 0) || a.title.localeCompare(b.title);
}
