import { expect, test } from "bun:test";
import { noticeRequest } from "../tools/liaison/notices.ts";
import { credentials, parseNotify } from "./notify.ts";

test("reads the coordinator's own Access token first, and names what's missing", () => {
	expect(credentials({ TOOLS_COORDINATOR_CLIENT_ID: "c", TOOLS_COORDINATOR_CLIENT_SECRET: "s", CF_ACCESS_CLIENT_ID: "other", CF_ACCESS_CLIENT_SECRET: "other", BOT_TOKEN_COORDINATOR: "t" })).toEqual({ clientId: "c", clientSecret: "s", token: "t" });
	expect(credentials({ CF_ACCESS_CLIENT_ID: "c", CF_ACCESS_CLIENT_SECRET: "s", BOT_TOKEN_COORDINATOR: "t" })).toEqual({ clientId: "c", clientSecret: "s", token: "t" });
	expect(() => credentials({ TOOLS_COORDINATOR_CLIENT_ID: "c" })).toThrow("Set TOOLS_COORDINATOR_CLIENT_SECRET, BOT_TOKEN_COORDINATOR first.");
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
