import { z } from "zod";
import type { Database } from "../../worker/db.ts";
import { LIAISON_RECEIVER_CHARS, liaisonEnvelope, liaisonWire, queueForLiaison } from "./webhook.ts";

const GENERAL_LABELS = ["action needed", "FYI", "nothing"] as const;

export const RECIPIENTS = {
	liaison: { name: "liaison", labels: GENERAL_LABELS },
	nutrition: { name: "nutrition bot", labels: GENERAL_LABELS },
	coach: { name: "coach", labels: ["no action", "please confirm"], confirmLabel: "please confirm" },
	fog: { name: "fog", labels: GENERAL_LABELS },
	tinkabot: { name: "tinkabot", labels: GENERAL_LABELS },
	all: { name: "all bots", labels: GENERAL_LABELS },
} as const satisfies Record<string, { name: string; labels: readonly string[]; confirmLabel?: string }>;

export type Recipient = keyof typeof RECIPIENTS;

const RECIPIENT_NAMES = Object.keys(RECIPIENTS) as [Recipient, ...Recipient[]];
const SUBJECT_CHARS = 200;
const BODY_CHARS = 64_000;
const MAX_REFS = 20;
const TEST_PREFIX = /^TEST\b/;

export class Refused extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function confirmLabel(to: Recipient): string | undefined {
	const recipient = RECIPIENTS[to];
	return "confirmLabel" in recipient ? recipient.confirmLabel : undefined;
}

export const noticeRequest = z
	.strictObject({
		for: z.enum(RECIPIENT_NAMES),
		label: z.string(),
		confirm: z.string().trim().min(1).max(SUBJECT_CHARS).optional(),
		noticeId: z.uuid().optional(),
		subject: z.string().trim().min(1).max(SUBJECT_CHARS),
		body: z.string().trim().min(1).max(BODY_CHARS),
		refs: z.array(z.url({ protocol: /^https$/ })).max(MAX_REFS).default([]),
		replyTo: z.uuid().optional(),
		test: z.boolean().default(false),
	})
	.superRefine((notice, issues) => {
		const labels: readonly string[] = RECIPIENTS[notice.for].labels;
		const confirming = confirmLabel(notice.for);
		if (!labels.includes(notice.label)) {
			issues.addIssue({ code: "custom", path: ["label"], message: `${notice.for} takes one of: ${labels.join(", ")}` });
		} else if (notice.label === confirming && notice.confirm === undefined) {
			issues.addIssue({ code: "custom", path: ["confirm"], message: `"${notice.label}" needs confirm: what ${notice.for} should confirm` });
		} else if (notice.label !== confirming && notice.confirm !== undefined) {
			issues.addIssue({ code: "custom", path: ["confirm"], message: confirming === undefined ? `${notice.for} takes no confirm` : `confirm goes only with "${confirming}"` });
		}
		if (!notice.test && TEST_PREFIX.test(notice.subject)) {
			issues.addIssue({ code: "custom", path: ["subject"], message: "Only a test notice may start its subject with TEST. Send test: true or reword the subject." });
		}
	});

export type NoticeRequest = z.infer<typeof noticeRequest>;

export type NoticeData = {
	for: Recipient;
	label: string;
	confirm?: string;
	line: string;
	subject: string;
	body: string;
	refs: string[];
	threadId: string;
	replyTo: string | null;
	createdAt: string;
};

export function noticeData(notice: NoticeRequest, ids: { noticeId: string; threadId: string; createdAt: string }): NoticeData {
	const name = RECIPIENTS[notice.for].name;
	return {
		for: notice.for,
		label: notice.label,
		...(notice.confirm === undefined ? {} : { confirm: notice.confirm }),
		line: notice.confirm === undefined ? `${name}: ${notice.label}` : `${name}: ${notice.label} ${notice.confirm}`,
		subject: notice.test && !TEST_PREFIX.test(notice.subject) ? `TEST ${notice.subject}` : notice.subject,
		body: notice.body,
		refs: notice.refs,
		threadId: ids.threadId,
		replyTo: notice.replyTo ?? null,
		createdAt: ids.createdAt,
	};
}

type StoredNotice = { test: boolean; data: NoticeData };
type StoredRow = { payload: { test?: boolean; data: NoticeData } };

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.toSorted(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sameNotice(stored: StoredNotice, notice: NoticeRequest): boolean {
	const expected = noticeData(notice, { noticeId: "", threadId: stored.data.threadId, createdAt: stored.data.createdAt });
	return stored.test === notice.test && canonical(stored.data) === canonical(expected);
}

async function readNotice(client: Database, noticeId: string): Promise<StoredNotice | undefined> {
	const row = (await client.query<StoredRow>("select payload from liaison.deliveries where delivery_id = $1 and app = 'tools' and event = 'notice'", [noticeId])).rows[0];
	return row === undefined ? undefined : { test: row.payload.test === true, data: row.payload.data };
}

export async function queueNotice(client: Database, notice: NoticeRequest): Promise<{ noticeId: string; created: boolean }> {
	const noticeId = notice.noticeId ?? crypto.randomUUID();
	const existing = await readNotice(client, noticeId);
	if (existing !== undefined) {
		if (!sameNotice(existing, notice)) throw new Refused(409, `noticeId ${noticeId} was already used for a different notice. Send a new noticeId.`);
		return { noticeId, created: false };
	}
	let threadId = noticeId;
	if (notice.replyTo !== undefined) {
		const parent = await readNotice(client, notice.replyTo);
		if (parent === undefined) throw new Refused(404, `replyTo ${notice.replyTo} is not a notice tools sent.`);
		threadId = parent.data.threadId;
	}
	const data = noticeData(notice, { noticeId, threadId, createdAt: new Date().toISOString() });
	const event = { app: "tools" as const, event: "notice", ref: threadId, test: notice.test, data };
	const chars = JSON.stringify(liaisonWire(liaisonEnvelope(event, noticeId))).length;
	if (chars > LIAISON_RECEIVER_CHARS) {
		throw new Refused(
			413,
			`This notice is ${chars} characters as sent, and the liaison keeps only the first ${LIAISON_RECEIVER_CHARS}. Shorten the body by ${chars - LIAISON_RECEIVER_CHARS} or more, or split it into notices that reply to this one with replyTo.`,
		);
	}
	await queueForLiaison(client, event, noticeId);
	return { noticeId, created: true };
}
