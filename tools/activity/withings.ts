declare global {
	interface Env {
		WITHINGS_CLIENT_ID?: string;
		WITHINGS_CLIENT_SECRET?: string;
	}
}

export const CALLBACK_URL = "https://tools.mattpalmer.io/api/withings/callback";
export const SCOPE = "user.info,user.metrics,user.activity";

const AUTHORIZE_URL = "https://account.withings.com/oauth2_user/authorize2";
const API = "https://wbsapi.withings.net";
const DATA_FIELDS = "steps,distance,elevation,soft,moderate,intense,active,calories,totalcalories,hr_average,hr_min,hr_max,hr_zone_0,hr_zone_1,hr_zone_2,hr_zone_3";
const WORKOUT_FIELDS =
	"calories,intensity,manual_distance,manual_calories,hr_average,hr_min,hr_max,hr_zone_0,hr_zone_1,hr_zone_2,hr_zone_3,pause_duration,algo_pause_duration,spo2_average,steps,distance,elevation,pool_laps,strokes,pool_length";
const SLEEP_FIELDS =
	"total_sleep_time,total_timeinbed,lightsleepduration,deepsleepduration,remsleepduration,wakeupduration,wakeupcount,durationtosleep,durationtowakeup,sleep_efficiency,sleep_latency,wakeup_latency,waso,nb_rem_episodes,out_of_bed_count,hr_average,hr_min,hr_max,rr_average,rr_min,rr_max,breathing_disturbances_intensity,snoring,snoringepisodecount,sleep_score,apnea_hypopnea_index";
const INTRADAY_FIELDS = "steps,elevation,calories,distance,stroke,pool_lap,duration,heart_rate,spo2_auto";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type Credentials = { clientId: string; clientSecret: string };
export type Tokens = { userid: string; scope: string; accessToken: string; refreshToken: string; expiresAt: Date };

export type WithingsActivity = {
	date: string;
	steps?: number | null;
	distance?: number | null;
	elevation?: number | null;
	soft?: number | null;
	moderate?: number | null;
	intense?: number | null;
	calories?: number | null;
	totalcalories?: number | null;
	hr_average?: number | null;
	hr_min?: number | null;
	hr_max?: number | null;
	hr_zone_0?: number | null;
	hr_zone_1?: number | null;
	hr_zone_2?: number | null;
	hr_zone_3?: number | null;
	deviceid?: string | null;
	brand?: number | null;
	is_tracker?: boolean | null;
};

export type ActivityPage = { activities: WithingsActivity[]; more: boolean; offset: number };

export class WithingsError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}

	get needsReconnect(): boolean {
		return this.status === 100 || this.status === 101 || this.status === 102 || this.status === 200 || this.status === 401;
	}
}

export function credentials(env: Env): Credentials | null {
	const clientId = env.WITHINGS_CLIENT_ID?.trim();
	const clientSecret = env.WITHINGS_CLIENT_SECRET?.trim();
	return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function authorizeUrl({ clientId }: Credentials, state: string): string {
	const params = new URLSearchParams({ response_type: "code", client_id: clientId, scope: SCOPE, redirect_uri: CALLBACK_URL, state });
	return `${AUTHORIZE_URL}?${params}`;
}

async function call<T>(fetcher: Fetch, path: string, form: Record<string, string>, accessToken?: string): Promise<T> {
	const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
	if (accessToken !== undefined) headers["authorization"] = `Bearer ${accessToken}`;
	const response = await fetcher(`${API}${path}`, { method: "POST", headers, body: new URLSearchParams(form).toString() });
	const json = (await response.json().catch(() => null)) as { status?: number; body?: T; error?: string } | null;
	if (json === null || typeof json.status !== "number") throw new WithingsError(`Withings ${form["action"]} answered HTTP ${response.status} without a status`, response.status);
	if (json.status !== 0 || json.body === undefined) throw new WithingsError(`Withings ${form["action"]} failed with status ${json.status}${json.error ? `: ${json.error}` : ""}`, json.status);
	return json.body;
}

type TokenBody = { userid: string | number; access_token: string; refresh_token: string; expires_in: number; scope: string };

function toTokens(body: TokenBody, now: Date): Tokens {
	return { userid: String(body.userid), scope: body.scope, accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: new Date(now.getTime() + body.expires_in * 1000) };
}

export async function exchangeCode(fetcher: Fetch, creds: Credentials, code: string, now = new Date()): Promise<Tokens> {
	const body = await call<TokenBody>(fetcher, "/v2/oauth2", {
		action: "requesttoken",
		grant_type: "authorization_code",
		client_id: creds.clientId,
		client_secret: creds.clientSecret,
		code,
		redirect_uri: CALLBACK_URL,
	});
	return toTokens(body, now);
}

export async function refreshTokens(fetcher: Fetch, creds: Credentials, refreshToken: string, now = new Date()): Promise<Tokens> {
	const body = await call<TokenBody>(fetcher, "/v2/oauth2", {
		action: "requesttoken",
		grant_type: "refresh_token",
		client_id: creds.clientId,
		client_secret: creds.clientSecret,
		refresh_token: refreshToken,
	});
	return toTokens(body, now);
}

export type MeasureGroup = { grpid: number; attrib: number; date: number; category?: number; model?: string | null; measures: { value: number; type: number; unit: number }[] };
export type MeasurePage = { groups: MeasureGroup[]; more: boolean; offset: number; updatetime: number };

export async function getWeights(fetcher: Fetch, accessToken: string, lastupdate: number, offset: number): Promise<MeasurePage> {
	const form: Record<string, string> = { action: "getmeas", meastypes: "1,6,8", category: "1", lastupdate: String(lastupdate) };
	if (offset > 0) form["offset"] = String(offset);
	const body = await call<{ measuregrps?: MeasureGroup[]; more?: boolean | number; offset?: number; updatetime: number }>(fetcher, "/measure", form, accessToken);
	return { groups: body.measuregrps ?? [], more: Boolean(body.more), offset: body.offset ?? 0, updatetime: body.updatetime };
}

export type Feed = "measures" | "workouts" | "sleep";
type Series = Record<string, unknown>;
export type FeedPage = { items: Series[]; more: boolean; offset: number; updatetime: number | null };

const FEEDS: Record<Feed, { path: string; form: Record<string, string> }> = {
	measures: { path: "/measure", form: { action: "getmeas", category: "1" } },
	workouts: { path: "/v2/measure", form: { action: "getworkouts", data_fields: WORKOUT_FIELDS } },
	sleep: { path: "/v2/sleep", form: { action: "getsummary", data_fields: SLEEP_FIELDS } },
};

export async function getFeed(fetcher: Fetch, accessToken: string, feed: Feed, lastupdate: number, offset: number): Promise<FeedPage> {
	const form: Record<string, string> = { ...FEEDS[feed].form, lastupdate: String(lastupdate) };
	if (offset > 0) form["offset"] = String(offset);
	const body = await call<{ measuregrps?: Series[]; series?: Series[]; more?: boolean | number; offset?: number; updatetime?: number }>(fetcher, FEEDS[feed].path, form, accessToken);
	return { items: body.measuregrps ?? body.series ?? [], more: Boolean(body.more), offset: body.offset ?? 0, updatetime: body.updatetime ?? null };
}

export type IntradaySample = { steps?: number; calories?: number; distance?: number; elevation?: number; heart_rate?: number; spo2_auto?: number; model?: string; model_id?: number; deviceid?: string };

export async function getIntraday(fetcher: Fetch, accessToken: string, startdate: number, enddate: number): Promise<Record<string, IntradaySample>> {
	const form = { action: "getintradayactivity", startdate: String(startdate), enddate: String(enddate), data_fields: INTRADAY_FIELDS };
	const body = await call<{ series?: Record<string, IntradaySample> | IntradaySample[] }>(fetcher, "/v2/measure", form, accessToken);
	return body.series !== undefined && !Array.isArray(body.series) ? body.series : {};
}

export async function getActivity(fetcher: Fetch, accessToken: string, from: string, to: string, offset: number): Promise<ActivityPage> {
	const form: Record<string, string> = { action: "getactivity", startdateymd: from, enddateymd: to, data_fields: DATA_FIELDS };
	if (offset > 0) form["offset"] = String(offset);
	const body = await call<{ activities?: WithingsActivity[]; more?: boolean | number; offset?: number }>(fetcher, "/v2/measure", form, accessToken);
	return { activities: body.activities ?? [], more: Boolean(body.more), offset: body.offset ?? 0 };
}
