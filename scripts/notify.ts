import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const USAGE = `Usage:
  bun run notify <for> <label> --subject <text> [--body-file <path>] [--confirm <text>] [--ref <https url>]... [--reply-to <id>] [--test] [--notice-id <id>] [--dry-run]
  bun run notify --list [--app nutrition|workouts|tools] [--thread <id>]

<for> is nutrition, coach, fog, tinkabot or all. Without --body-file the markdown body is read from stdin.
Needs TOOLS_COORDINATOR_CLIENT_ID, TOOLS_COORDINATOR_CLIENT_SECRET and BOT_TOKEN_COORDINATOR (CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET also work). TOOLS_URL defaults to https://tools.mattpalmer.io.`;

const ATTEMPTS = 3;
const RETRY_MS = 2_000;

export type NotifyArgs = { list: false; notice: Record<string, unknown>; dryRun: boolean } | { list: true; query: URLSearchParams };

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
		},
	});
	if (values.list) {
		const query = new URLSearchParams();
		if (values.app !== undefined) query.set("app", values.app);
		if (values.thread !== undefined) query.set("thread", values.thread);
		return { list: true, query };
	}
	const [recipient, label, ...extra] = positionals;
	if (recipient === undefined || label === undefined || extra.length > 0 || values.subject === undefined) throw new Error(USAGE);
	if (body === null || body.trim() === "") throw new Error("The notice needs a markdown body, from --body-file or stdin.");
	return {
		list: false,
		dryRun: values["dry-run"] === true,
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

export function credentials(env: Record<string, string | undefined>): { clientId: string; clientSecret: string; token: string } {
	const clientId = env["TOOLS_COORDINATOR_CLIENT_ID"] || env["CF_ACCESS_CLIENT_ID"];
	const clientSecret = env["TOOLS_COORDINATOR_CLIENT_SECRET"] || env["CF_ACCESS_CLIENT_SECRET"];
	const token = env["BOT_TOKEN_COORDINATOR"];
	const missing = [
		clientId ? null : "TOOLS_COORDINATOR_CLIENT_ID",
		clientSecret ? null : "TOOLS_COORDINATOR_CLIENT_SECRET",
		token ? null : "BOT_TOKEN_COORDINATOR",
	].filter((name) => name !== null);
	if (missing.length > 0 || !clientId || !clientSecret || !token) throw new Error(`Set ${missing.join(", ")} first.`);
	return { clientId, clientSecret, token };
}

function headers(): Record<string, string> {
	const { clientId, clientSecret, token } = credentials(process.env);
	return {
		"cf-access-client-id": clientId,
		"cf-access-client-secret": clientSecret,
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": "tools-notify/1",
	};
}

async function request(url: string, init: RequestInit): Promise<Response> {
	for (let attempt = 1; ; attempt++) {
		try {
			const response = await fetch(url, { ...init, redirect: "manual" });
			if ((response.status < 500 && response.status !== 429) || attempt === ATTEMPTS) return response;
		} catch (error) {
			if (attempt === ATTEMPTS) throw error;
		}
		await Bun.sleep(RETRY_MS * attempt);
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
	const response = args.list
		? await request(`${base}/api/tools/liaison/deliveries?${args.query}`, { headers: headers() })
		: await request(`${base}/api/tools/liaison/notices`, { method: "POST", headers: headers(), body: JSON.stringify(args.notice) });
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
