import { expect, test } from "bun:test";
import { noticeRequest } from "../tools/liaison/notices.ts";
import { credentials, mintCredentials, parseNotify } from "./notify.ts";

const COORDINATOR = "9f5386b746c91cbc0774e9f806a081fa.access";
const CF = { CLOUDFLARE_API_TOKEN: "cf-api", CLOUDFLARE_ACCOUNT_ID: "acct" };

function fakeCloudflare(answers: Record<string, unknown>) {
	const calls: { url: string; method: string; authorization: string | null; body: unknown }[] = [];
	const fetcher = async (url: string, init?: RequestInit) => {
		calls.push({ url, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization"), body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
		const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
		return key in answers ? Response.json({ success: true, result: answers[key] }) : Response.json({ success: false, errors: [{ message: "not found" }] }, { status: 404 });
	};
	return { calls, fetcher };
}

test("uses the stored coordinator token and never rotates when it is set", async () => {
	const { calls, fetcher } = fakeCloudflare({});
	expect(await credentials({ TOOLS_COORDINATOR_CLIENT_ID: "c", TOOLS_COORDINATOR_CLIENT_SECRET: "s", ...CF }, true, fetcher)).toEqual({ clientId: "c", clientSecret: "s" });
	expect(calls).toEqual([]);
});

test("without stored values it refuses unless --mint, and never falls back to another bot's token", async () => {
	const { calls, fetcher } = fakeCloudflare({});
	await expect(credentials({ CF_ACCESS_CLIENT_ID: "smoke", CF_ACCESS_CLIENT_SECRET: "s", BOT_TOKEN_COORDINATOR: "t" }, false, fetcher)).rejects.toThrow("pass --mint");
	await expect(credentials({ TOOLS_COORDINATOR_CLIENT_ID: "c" }, true, fetcher)).rejects.toThrow("--mint needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
	expect(calls).toEqual([]);
});

test("--mint rotates only the tools-coordinator secret, keeping the previous one valid for an hour", async () => {
	const { calls, fetcher } = fakeCloudflare({
		"GET /client/v4/accounts/acct/access/service_tokens": [
			{ id: "smoke-id", client_id: "3764ccd9a5d87214d1032418b8c228ed.access" },
			{ id: "coordinator-id", client_id: COORDINATOR },
		],
		"POST /client/v4/accounts/acct/access/service_tokens/coordinator-id/rotate": { client_secret: "fresh" },
	});
	expect(await mintCredentials(CF, fetcher, Date.UTC(2026, 10, 22, 18))).toEqual({ clientId: COORDINATOR, clientSecret: "fresh" });
	expect(calls.map(({ method, url, authorization, body }) => ({ method, path: new URL(url).pathname, authorization, body }))).toEqual([
		{ method: "GET", path: "/client/v4/accounts/acct/access/service_tokens", authorization: "Bearer cf-api", body: null },
		{ method: "POST", path: "/client/v4/accounts/acct/access/service_tokens/coordinator-id/rotate", authorization: "Bearer cf-api", body: { previous_client_secret_expires_at: "2026-11-22T19:00:00.000Z" } },
	]);
});

test("--mint stops when the coordinator token is missing or Cloudflare refuses", async () => {
	await expect(mintCredentials(CF, fakeCloudflare({ "GET /client/v4/accounts/acct/access/service_tokens": [] }).fetcher)).rejects.toThrow("No Access service token named tools-coordinator");
	const refused = fakeCloudflare({ "GET /client/v4/accounts/acct/access/service_tokens": [{ id: "coordinator-id", client_id: COORDINATOR }] });
	await expect(mintCredentials(CF, refused.fetcher)).rejects.toThrow("Cloudflare API POST /accounts/acct/access/service_tokens/coordinator-id/rotate answered HTTP 404: not found");
});

test("parses --mint for sends and lists", () => {
	expect(parseNotify(["FYI", "--subject", "s", "--mint"], "b").mint).toBe(true);
	expect(parseNotify(["--list", "--mint"], null).mint).toBe(true);
	expect(parseNotify(["FYI", "--subject", "s"], "b").mint).toBe(false);
});

test("builds a notice the route accepts, with a fresh noticeId so retries stay idempotent", () => {
	const args = parseNotify(["coach", "please confirm", "--subject", "History import", "--confirm", "you still write kind", "--ref", "https://github.com/mattppal/tools/pull/41", "--test"], "## Body\n");
	if (args.list) throw new Error("expected a notice");
	expect(args.notice).toMatchObject({ for: "coach", label: "please confirm", confirm: "you still write kind", refs: ["https://github.com/mattppal/tools/pull/41"], test: true, body: "## Body\n" });
	expect(noticeRequest.safeParse(args.notice).success).toBe(true);
	const again = parseNotify(["nutrition", "FYI", "--subject", "s"], "b");
	if (again.list) throw new Error("expected a notice");
	expect(again.notice["noticeId"]).not.toBe(args.notice["noticeId"]);
});

test("sends to the liaison when no recipient is named", () => {
	const args = parseNotify(["FYI", "--subject", "s"], "b");
	if (args.list) throw new Error("expected a notice");
	expect(args.notice).toMatchObject({ for: "liaison", label: "FYI" });
	expect(noticeRequest.safeParse(args.notice).success).toBe(true);
	expect(() => parseNotify(["coach", "no action", "extra", "--subject", "s"], "b")).toThrow("Usage");
});

test("keeps a given noticeId and replyTo", () => {
	const args = parseNotify(["nutrition", "nothing", "--subject", "s", "--notice-id", "9b2e7c4a-1d5f-4a8e-b3c6-0f7d2e9a4b18", "--reply-to", "4c1a9e6b-7f2d-4b3e-a8c5-2d9f6b1e7a30"], "b");
	if (args.list) throw new Error("expected a notice");
	expect(args.notice).toMatchObject({ noticeId: "9b2e7c4a-1d5f-4a8e-b3c6-0f7d2e9a4b18", replyTo: "4c1a9e6b-7f2d-4b3e-a8c5-2d9f6b1e7a30" });
});

test("refuses a notice without a subject or body, and builds the list query", () => {
	expect(() => parseNotify(["nutrition", "FYI"], "b")).toThrow("Usage");
	expect(() => parseNotify(["nutrition", "FYI", "--subject", "s"], "  ")).toThrow("markdown body");
	const list = parseNotify(["--list", "--app", "tools"], null);
	expect(list.list && list.query.toString()).toBe("app=tools");
});
