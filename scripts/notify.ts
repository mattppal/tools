import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { BOTS } from "../worker/access.ts";

const USAGE = `Usage:
  bun run notify [<for>] <label> --subject <text> [--body-file <path>] [--confirm <text>] [--ref <https url>]... [--reply-to <id>] [--test] [--notice-id <id>] [--dry-run] [--mint]
  bun run notify --list [--app nutrition|workouts|tools] [--thread <id>] [--mint]

<for> is liaison (the default), nutrition, coach, fog, tinkabot or all; all goes to every bot. Without --body-file the markdown body is read from stdin.
Sends the tools-coordinator Access service token, from TOOLS_COORDINATOR_CLIENT_ID and TOOLS_COORDINATOR_CLIENT_SECRET. When those are unset, --mint rotates that token's secret with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID and uses it for this run only, waiting up to 30 seconds while Access answers 302 until the new secret reaches it. TOOLS_URL defaults to https://tools.mattpalmer.io.`;

const ATTEMPTS = 3;
const RETRY_MS = 2_000;
const MINT_GRACE_MS = 60 * 60_000;
const MINT_POLL_MS = 2_000;
const MINT_PROPAGATION_MS = 30_000;
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export type NotifyArgs = { list: false; notice: Record<string, unknown>; dryRun: boolean; mint: boolean } | { list: true; query: URLSearchParams; mint: boolean };

export type Credentials = { clientId: string; clientSecret: string };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function parseNotify(argv: readonly string[], body: string | null): NotifyArgs {
	const { values, positionals } = parseArgs({
		args: [...argv],
		allowPositionals: true,
		options: {
			subject: { type: "string" },
			"body-file": { type: "string" },
			confirm: { type: "string" },
			ref: { type: "string", multiple: true },
			"reply-to": { type: "string" },
			test: { type: "boolean" },
			"notice-id": { type: "string" },
			"dry-run": { type: "boolean" },
			list: { type: "boolean" },
			app: { type: "string" },
			thread: { type: "string" },
			mint: { type: "boolean" },
		},
	});
	const mint = values.mint === true;
	if (values.list) {
		const query = new URLSearchParams();
		if (values.app !== undefined) query.set("app", values.app);
		if (values.thread !== undefined) query.set("thread", values.thread);
		return { list: true, query, mint };
	}
	const [recipient, label] = positionals.length === 1 ? ["liaison", positionals[0]] : positionals;
	if (recipient === undefined || label === undefined || positionals.length > 2 || values.subject === undefined) throw new Error(USAGE);
	if (body === null || body.trim() === "") throw new Error("The notice needs a markdown body, from --body-file or stdin.");
	return {
		list: false,
		dryRun: values["dry-run"] === true,
		mint,
		notice: {
			for: recipient,
			label,
			subject: values.subject,
			body,
			refs: values.ref ?? [],
			noticeId: values["notice-id"] ?? crypto.randomUUID(),
			test: values.test === true,
			...(values.confirm === undefined ? {} : { confirm: values.confirm }),
			...(values["reply-to"] === undefined ? {} : { replyTo: values["reply-to"] }),
		},
	};
}

async function cloudflare<T>(fetcher: Fetch, path: string, apiToken: string, init: RequestInit = {}): Promise<T> {
	const response = await fetcher(`${CLOUDFLARE_API}${path}`, { ...init, headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" } });
	const body = (await response.json().catch(() => null)) as { success?: unknown; result?: T; errors?: { message?: unknown }[] } | null;
	if (response.ok && body?.success === true && body.result !== undefined) return body.result;
	throw new Error(`Cloudflare API ${init.method ?? "GET"} ${path.split("?")[0]} answered HTTP ${response.status}: ${body?.errors?.map((error) => String(error.message)).join("; ") || "no details"}`);
}

export async function mintCredentials(env: Record<string, string | undefined>, fetcher: Fetch = fetch, now: number = Date.now()): Promise<Credentials> {
	const apiToken = env["CLOUDFLARE_API_TOKEN"];
	const account = env["CLOUDFLARE_ACCOUNT_ID"];
	if (!apiToken || !account) throw new Error("--mint needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
	const { clientId, serviceToken } = BOTS.coordinator;
	const tokens = await cloudflare<{ id: string; client_id: string }[]>(fetcher, `/accounts/${account}/access/service_tokens?per_page=1000`, apiToken);
	const token = tokens.find((candidate) => candidate.client_id === clientId);
	if (token === undefined) throw new Error(`No Access service token named ${serviceToken} has client ID ${clientId}.`);
	const rotated = await cloudflare<{ client_secret: string }>(fetcher, `/accounts/${account}/access/service_tokens/${token.id}/rotate`, apiToken, {
		method: "POST",
		body: JSON.stringify({ previous_client_secret_expires_at: new Date(now + MINT_GRACE_MS).toISOString() }),
	});
	return { clientId, clientSecret: rotated.client_secret };
}

export async function credentials(env: Record<string, string | undefined>, mint: boolean, fetcher: Fetch = fetch): Promise<Credentials> {
	const clientId = env["TOOLS_COORDINATOR_CLIENT_ID"];
	const clientSecret = env["TOOLS_COORDINATOR_CLIENT_SECRET"];
	if (clientId && clientSecret) return { clientId, clientSecret };
	if (mint) return await mintCredentials(env, fetcher);
	throw new Error("Set TOOLS_COORDINATOR_CLIENT_ID and TOOLS_COORDINATOR_CLIENT_SECRET first, or pass --mint.");
}

function headers({ clientId, clientSecret }: Credentials): Record<string, string> {
	return {
		"cf-access-client-id": clientId,
		"cf-access-client-secret": clientSecret,
		"content-type": "application/json",
		"user-agent": "tools-notify/1",
	};
}

export async function request(url: string, init: RequestInit, minted: boolean, fetcher: Fetch = fetch, sleep: (ms: number) => Promise<void> = Bun.sleep): Promise<Response> {
	for (let attempt = 1, waited = 0; ; attempt++) {
		try {
			const response = await fetcher(url, { ...init, redirect: "manual" });
			if (minted && response.status === 302 && waited < MINT_PROPAGATION_MS) {
				await sleep(MINT_POLL_MS);
				waited += MINT_POLL_MS;
				attempt--;
				continue;
			}
			if ((response.status < 500 && response.status !== 429) || attempt === ATTEMPTS) return response;
		} catch (error) {
			if (attempt === ATTEMPTS) throw error;
		}
		await sleep(RETRY_MS * attempt);
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const bodyFile = argv[argv.indexOf("--body-file") + 1];
	const wantsBody = !argv.includes("--list");
	const body = !wantsBody ? null : argv.includes("--body-file") && bodyFile !== undefined ? await readFile(bodyFile, "utf8") : process.stdin.isTTY ? null : await Bun.stdin.text();
	const args = parseNotify(argv, body);
	const base = (process.env["TOOLS_URL"] ?? "https://tools.mattpalmer.io").replace(/\/$/, "");
	if (!args.list && args.dryRun) {
		console.log(JSON.stringify(args.notice, null, 2));
		return;
	}
	const minted = args.mint && !(process.env["TOOLS_COORDINATOR_CLIENT_ID"] && process.env["TOOLS_COORDINATOR_CLIENT_SECRET"]);
	const sent = headers(await credentials(process.env, args.mint));
	const response = args.list
		? await request(`${base}/api/tools/liaison/deliveries?${args.query}`, { headers: sent }, minted)
		: await request(`${base}/api/tools/liaison/notices`, { method: "POST", headers: sent, body: JSON.stringify(args.notice) }, minted);
	const text = await response.text();
	console.log(`HTTP ${response.status}`);
	console.log(text);
	if (!response.ok) process.exitCode = 1;
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
