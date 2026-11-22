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
const DATA_FIELDS = "steps,distance,elevation,soft,moderate,intense,active,calories,totalcalories";

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

export async function getActivity(fetcher: Fetch, accessToken: string, from: string, to: string, offset: number): Promise<ActivityPage> {
	const form: Record<string, string> = { action: "getactivity", startdateymd: from, enddateymd: to, data_fields: DATA_FIELDS };
	if (offset > 0) form["offset"] = String(offset);
	const body = await call<{ activities?: WithingsActivity[]; more?: boolean | number; offset?: number }>(fetcher, "/v2/measure", form, accessToken);
	return { activities: body.activities ?? [], more: Boolean(body.more), offset: body.offset ?? 0 };
}
