import type { Database } from "../../worker/db.ts";
import { seal } from "./secrets.ts";
import type { Tokens, WithingsActivity } from "./withings.ts";

type Row = Record<string, unknown>;

export type ActivityDay = {
	date: string;
	source: string;
	steps: number | null;
	activeKcal: number | null;
	totalKcal: number | null;
	distanceM: number | null;
};

export type Connection = {
	userid: string;
	scope: string;
	accessToken: string;
	refreshToken: string;
	accessExpiresAt: Date;
	connectedAt: string;
	refreshedAt: string | null;
	backfillCursor: string | null;
	backfillOffset: number;
	backfillDoneAt: string | null;
	recentSyncedAt: string | null;
	lastError: string | null;
	lastErrorAt: string | null;
	measLastupdate: number | null;
	measPendingLastupdate: number | null;
	measOffset: number;
	weightsSyncedAt: string | null;
};

const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const isoOrNull = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : textOrNull(value));

function toConnection(row: Row): Connection {
	return {
		userid: String(row["userid"]),
		scope: String(row["scope"]),
		accessToken: String(row["access_token"]),
		refreshToken: String(row["refresh_token"]),
		accessExpiresAt: new Date(row["access_expires_at"] as string | Date),
		connectedAt: isoOrNull(row["connected_at"]) ?? "",
		refreshedAt: isoOrNull(row["refreshed_at"]),
		backfillCursor: textOrNull(row["backfill_cursor"]),
		backfillOffset: Number(row["backfill_offset"]),
		backfillDoneAt: isoOrNull(row["backfill_done_at"]),
		recentSyncedAt: isoOrNull(row["recent_synced_at"]),
		lastError: textOrNull(row["last_error"]),
		lastErrorAt: isoOrNull(row["last_error_at"]),
		measLastupdate: numOrNull(row["meas_lastupdate"]),
		measPendingLastupdate: numOrNull(row["meas_pending_lastupdate"]),
		measOffset: Number(row["meas_offset"]),
		weightsSyncedAt: isoOrNull(row["weights_synced_at"]),
	};
}

const CONNECTION_COLUMNS = `userid, scope, access_token, refresh_token, access_expires_at, connected_at, refreshed_at, backfill_cursor::text as backfill_cursor,
	backfill_offset, backfill_done_at, recent_synced_at, last_error, last_error_at, meas_lastupdate, meas_pending_lastupdate, meas_offset, weights_synced_at`;

export async function readConnection(client: Database): Promise<Connection | null> {
	const row = (await client.query<Row>(`select ${CONNECTION_COLUMNS} from activity.withings where id`)).rows[0];
	return row === undefined ? null : toConnection(row);
}

export async function saveConnection(client: Database, secret: string, tokens: Tokens, backfillFrom: string): Promise<void> {
	await client.query(
		`insert into activity.withings (id, userid, scope, access_token, refresh_token, access_expires_at, backfill_cursor)
		values (true, $1, $2, $3, $4, $5, $6)
		on conflict (id) do update set
			scope = excluded.scope, access_token = excluded.access_token, refresh_token = excluded.refresh_token,
			access_expires_at = excluded.access_expires_at, connected_at = now(), last_error = null, last_error_at = null,
			userid = excluded.userid,
			backfill_cursor = case when activity.withings.userid = excluded.userid then activity.withings.backfill_cursor else excluded.backfill_cursor end,
			backfill_offset = case when activity.withings.userid = excluded.userid then activity.withings.backfill_offset else 0 end,
			backfill_done_at = case when activity.withings.userid = excluded.userid then activity.withings.backfill_done_at else null end,
			recent_synced_at = null,
			meas_lastupdate = case when activity.withings.userid = excluded.userid then activity.withings.meas_lastupdate else null end,
			meas_pending_lastupdate = case when activity.withings.userid = excluded.userid then activity.withings.meas_pending_lastupdate else null end,
			meas_offset = case when activity.withings.userid = excluded.userid then activity.withings.meas_offset else 0 end`,
		[tokens.userid, tokens.scope, await seal(secret, tokens.accessToken), await seal(secret, tokens.refreshToken), tokens.expiresAt, backfillFrom],
	);
}

export async function claimConnection(client: Database): Promise<Connection | null> {
	const row = (
		await client.query<Row>(
			`update activity.withings set claimed_until = now() + interval '2 minutes'
			where id and (claimed_until is null or claimed_until < now())
			returning ${CONNECTION_COLUMNS}`,
		)
	).rows[0];
	return row === undefined ? null : toConnection(row);
}

export async function saveTokens(client: Database, secret: string, tokens: Tokens): Promise<void> {
	await client.query("update activity.withings set scope = $1, access_token = $2, refresh_token = $3, access_expires_at = $4, refreshed_at = now() where id", [
		tokens.scope,
		await seal(secret, tokens.accessToken),
		await seal(secret, tokens.refreshToken),
		tokens.expiresAt,
	]);
}

export type SyncProgress = {
	backfillCursor: string | null;
	backfillOffset: number;
	backfillDone: boolean;
	recentSynced: boolean;
	measLastupdate: number | null;
	measPendingLastupdate: number | null;
	measOffset: number;
	weightsSynced: boolean;
	error: string | null;
};

export async function releaseConnection(client: Database, progress: SyncProgress): Promise<void> {
	await client.query(
		`update activity.withings set
			backfill_cursor = $1, backfill_offset = $2,
			backfill_done_at = case when $3 and backfill_done_at is null then now() else backfill_done_at end,
			recent_synced_at = case when $4 then now() else recent_synced_at end,
			last_error = $5, last_error_at = case when $5::text is null then last_error_at else now() end,
			meas_lastupdate = $6, meas_pending_lastupdate = $7, meas_offset = $8,
			weights_synced_at = case when $9 then now() else weights_synced_at end,
			claimed_until = null
		where id`,
		[
			progress.backfillCursor,
			progress.backfillOffset,
			progress.backfillDone,
			progress.recentSynced,
			progress.error,
			progress.measLastupdate,
			progress.measPendingLastupdate,
			progress.measOffset,
			progress.weightsSynced,
		],
	);
}

function pick(activities: readonly WithingsActivity[]): Map<string, { best: WithingsActivity; all: WithingsActivity[] }> {
	const byDate = new Map<string, { best: WithingsActivity; all: WithingsActivity[] }>();
	for (const activity of activities) {
		const seen = byDate.get(activity.date);
		if (seen === undefined) byDate.set(activity.date, { best: activity, all: [activity] });
		else {
			seen.all.push(activity);
			if ((activity.steps ?? 0) > (seen.best.steps ?? 0)) seen.best = activity;
		}
	}
	return byDate;
}

export async function upsertWithingsDays(client: Database, activities: readonly WithingsActivity[]): Promise<number> {
	const rows = [...pick(activities).values()].map(({ best, all }) => ({
		day: best.date,
		steps: best.steps ?? null,
		active_kcal: best.calories ?? null,
		total_kcal: best.totalcalories ?? null,
		distance_m: best.distance ?? null,
		elevation_m: best.elevation ?? null,
		soft_s: best.soft ?? null,
		moderate_s: best.moderate ?? null,
		intense_s: best.intense ?? null,
		hr_avg: best.hr_average ?? null,
		hr_min: best.hr_min ?? null,
		hr_max: best.hr_max ?? null,
		hr_zone_0_s: best.hr_zone_0 ?? null,
		hr_zone_1_s: best.hr_zone_1 ?? null,
		hr_zone_2_s: best.hr_zone_2 ?? null,
		hr_zone_3_s: best.hr_zone_3 ?? null,
		device: best.deviceid ?? (best.brand === undefined || best.brand === null ? null : `brand ${best.brand}`),
		raw: all,
	}));
	if (rows.length === 0) return 0;
	const { rowCount } = await client.query(
		`insert into activity.days (day, source, steps, active_kcal, total_kcal, distance_m, elevation_m, soft_s, moderate_s, intense_s,
			hr_avg, hr_min, hr_max, hr_zone_0_s, hr_zone_1_s, hr_zone_2_s, hr_zone_3_s, device, raw, updated_by)
		select r.day, 'withings', r.steps, r.active_kcal, r.total_kcal, r.distance_m, r.elevation_m, r.soft_s, r.moderate_s, r.intense_s,
			r.hr_avg, r.hr_min, r.hr_max, r.hr_zone_0_s, r.hr_zone_1_s, r.hr_zone_2_s, r.hr_zone_3_s, r.device, r.raw, 'withings-sync'
		from jsonb_to_recordset($1::jsonb) as r (day date, steps integer, active_kcal numeric, total_kcal numeric, distance_m numeric, elevation_m numeric,
			soft_s integer, moderate_s integer, intense_s integer, hr_avg integer, hr_min integer, hr_max integer,
			hr_zone_0_s integer, hr_zone_1_s integer, hr_zone_2_s integer, hr_zone_3_s integer, device text, raw jsonb)
		on conflict (day, source) do update set
			steps = excluded.steps, active_kcal = excluded.active_kcal, total_kcal = excluded.total_kcal, distance_m = excluded.distance_m,
			elevation_m = excluded.elevation_m, soft_s = excluded.soft_s, moderate_s = excluded.moderate_s, intense_s = excluded.intense_s,
			hr_avg = excluded.hr_avg, hr_min = excluded.hr_min, hr_max = excluded.hr_max, hr_zone_0_s = excluded.hr_zone_0_s,
			hr_zone_1_s = excluded.hr_zone_1_s, hr_zone_2_s = excluded.hr_zone_2_s, hr_zone_3_s = excluded.hr_zone_3_s,
			device = excluded.device, raw = excluded.raw, updated_by = excluded.updated_by, updated_at = now()
		where (activity.days.steps, activity.days.active_kcal, activity.days.total_kcal, activity.days.distance_m, activity.days.raw)
			is distinct from (excluded.steps, excluded.active_kcal, excluded.total_kcal, excluded.distance_m, excluded.raw)`,
		[JSON.stringify(rows)],
	);
	return rowCount ?? 0;
}

export async function listDays(client: Database, from: string, to: string): Promise<ActivityDay[]> {
	const { rows } = await client.query<Row>(
		"select day::text as day, source, steps, active_kcal, total_kcal, distance_m from activity.daily_activity where day between $1 and $2 order by day desc",
		[from, to],
	);
	return rows.map((row) => ({
		date: String(row["day"]),
		source: String(row["source"]),
		steps: numOrNull(row["steps"]),
		activeKcal: numOrNull(row["active_kcal"]),
		totalKcal: numOrNull(row["total_kcal"]),
		distanceM: numOrNull(row["distance_m"]),
	}));
}
