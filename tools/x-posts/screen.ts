export const SCREEN_VERSION = 1;

export const FLAGS = ["injection", "addressed", "phone", "email", "blocked", "empty", "overlong", "mentions", "unprintable", "encoded"] as const;

export type Flag = (typeof FLAGS)[number];

export const REJECTING: readonly Flag[] = ["injection", "phone", "email", "blocked", "empty", "overlong"];

export const TEXT_CHARS = 500;

export const NAME_CHARS = 50;

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const URL = /https?:\/\/\S+/gi;
const EMAIL = /[\p{L}\p{Nd}._%+-]+@[\p{L}\p{Nd}-]+(?:\.[\p{L}\p{Nd}-]+)*\.\p{L}{2,}/gu;
const FLOOR_EMAIL = /[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+\.[\p{L}\p{N}_.-]{2,}/gu;
const EDGE = "[\\p{Nd}\\p{L}_]";
const D = "\\p{Nd}";
const SEP = "[ .\\-]?";
const PHONE = new RegExp(
	[
		`(?<!${EDGE}|[/.:])(?:\\+${D}{1,3}${SEP})?(?:\\(${D}{3}\\)|${D}{3})${SEP}${D}{3}${SEP}${D}{4}(?!${EDGE})`,
		`(?<!${EDGE}|[/.:])\\+${D}(?:${SEP}${D}){7,14}(?!${EDGE})`,
	].join("|"),
	"gu",
);
const FLOOR_PHONE = /(?<!\p{Nd})(?:\+?1[\s.-]?)?\(?\p{Nd}{3}\)?[\s.-]?\p{Nd}{3}[\s.-]?\p{Nd}{4}(?!\p{Nd})/gu;

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const INVISIBLE_CHARS = "\\u200B-\\u200F\\u2060-\\u2064\\uFEFF\\u202A-\\u202E\\u2066-\\u2069";
const INVISIBLE = new RegExp(`[${INVISIBLE_CHARS}]`, "gu");
const ANY_INVISIBLE = new RegExp(`[${INVISIBLE_CHARS}]`, "u");
const TAGS = /[\u{E0000}-\u{E007F}]/u;
const EMOJI_JOINER = /(\p{Extended_Pictographic}\p{Emoji_Modifier}?\uFE0F?)\u200D(?=\p{Extended_Pictographic})/gu;
const FLAG_TAG_SEQUENCE = /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]+\u{E007F}/gu;
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE00-\uFE0F\u20E3\u{E0020}-\u{E007F}]/gu;
const LEADING_MENTIONS = /^(?:\s*@[A-Za-z0-9_]{1,15}(?![A-Za-z0-9_]))+/;
const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;
const LONG_TOKEN = /[A-Za-z0-9+/=_-]{40,}/;

const STEERING = [
	/\b(?:ignore|disregard|forget|override|bypass)(?: (?:all|any|the|your|my|of|these|those))* (?:previous|prior|above|earlier|preceding|original|initial|system)(?: \w+)? (?:instructions?|prompts?|messages?|rules|directions|directives|guidelines)\b/,
	/\b(?:ignore|disregard|forget)(?: (?:all|everything|the))*(?: of)?(?: the)? above\b/,
	/\bsystem prompt\b/,
	/\byou are now\b/,
	/\bdeveloper mode\b/,
	/\bjailbr[eo]a?k/,
	/\bnew instructions\b/,
	/\bdo anything now\b/,
	/\bact as (?:an? )?(?:ai|bot|assistant|chatbot|language model)\b/,
	/\b(?:reveal|print|show|repeat|output) (?:your|the) (?:system |initial |hidden |original )?(?:prompt|instructions)\b/,
];

const FLOOR_INJECTION = new RegExp(
	[
		String.raw`ignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions|prompts?|messages?)`,
		String.raw`disregard (?:all |any |the )?(?:previous|prior|above|your) (?:instructions|rules|prompts?)`,
		String.raw`forget (?:all |everything|your) (?:instructions|rules|previous)`,
		String.raw`\bsystem prompt\b`,
		String.raw`\bdeveloper mode\b`,
		String.raw`\bjailbreak`,
		String.raw`\byou are now\b`,
		String.raw`\bact as (?:an?|the) (?:ai|assistant|agent|admin|root)`,
		String.raw`\bnew instructions?\b`,
		String.raw`\b(?:ai|llm|agent|assistant|bot|cursor|claude|grok|gpt)s?[,:]? (?:please )?(?:run|execute|print|ignore|reveal|output|send|delete)\b`,
		String.raw`\b(?:sudo|rm -rf|curl |wget |bash -c|powershell|eval\()`,
		String.raw`\b(?:api[_ ]?key|bearer token|password|secret|env(?:ironment)? var)`,
		String.raw`</?(?:system|assistant|user|instructions?|tool)>`,
		"```",
	]
		.map((pattern) => `(?:${pattern})`)
		.join("|"),
	"iu",
);

const TEMPLATE_TOKENS = ["<|", "|>", "[inst]", "[/inst]", "<<sys>>", "<</sys>>", "### system", "### instruction", "</s>"];
const TEMPLATE_ROLE = /(?:^|\s)(?:assistant|system)\s*:/;

const ADDRESSED_WORDS = [/\bmatty ?prints\b/, /\bprint this\b/];
const ADDRESSED_MENTION = /(?:^|[^\p{L}\p{Nd}_])@grok(?![A-Za-z0-9_])/u;

const CP437_HIGH =
	"ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";
const CP437 = new Set([...Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)), ...CP437_HIGH]);
const PUNCTUATION: Record<string, string> = {
	"\u2018": "'",
	"\u2019": "'",
	"\u201a": "'",
	"\u201b": "'",
	"\u2032": "'",
	"\u201c": '"',
	"\u201d": '"',
	"\u201e": '"',
	"\u2033": '"',
	"\u2010": "-",
	"\u2011": "-",
	"\u2012": "-",
	"\u2013": "-",
	"\u2014": "--",
	"\u2015": "--",
	"\u2026": "...",
	"\u2022": "*",
	"\u2009": " ",
	"\u202f": " ",
	"\t": " ",
};

export type Screened = { cleanText: string; cleanName: string; flags: Flag[]; notes: string[] };

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, entity: string) => {
		if (entity.startsWith("#x") || entity.startsWith("#X")) return safeCodePoint(Number.parseInt(entity.slice(2), 16)) ?? whole;
		if (entity.startsWith("#")) return safeCodePoint(Number.parseInt(entity.slice(1), 10)) ?? whole;
		return ENTITIES[entity.toLowerCase()] ?? whole;
	});
}

function safeCodePoint(code: number): string | null {
	return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : null;
}

function stripInvisible(text: string): string {
	return text.replace(CONTROL, "").replace(INVISIBLE, "");
}

function collapse(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

function cut(text: string, chars: number): { text: string; cut: boolean } {
	const points = Array.from(text);
	if (points.length <= chars) return { text, cut: false };
	return { text: `${points.slice(0, chars - 1).join("").trimEnd()}…`, cut: true };
}

export function toPrintable(text: string): string {
	let out = "";
	for (const char of Array.from(text.normalize("NFKC"))) {
		const mapped = PUNCTUATION[char] ?? char;
		if (mapped === "\n" || CP437.has(mapped) || mapped.length > 1) {
			out += mapped;
			continue;
		}
		if (/\p{C}/u.test(mapped)) continue;
		const stripped = mapped.normalize("NFKD").replace(/\p{M}/gu, "");
		if (Array.from(stripped).every((part) => CP437.has(part))) out += stripped;
	}
	return out;
}

type Masked = { text: string; phone: boolean; email: boolean };

function maskContacts(text: string): Masked {
	let email = false;
	let phone = false;
	const mark = (kind: "email" | "phone") => () => {
		if (kind === "email") email = true;
		else phone = true;
		return `[${kind}]`;
	};
	const masked = text.replace(EMAIL, mark("email")).replace(FLOOR_EMAIL, mark("email")).replace(PHONE, mark("phone")).replace(FLOOR_PHONE, mark("phone"));
	return { text: masked, phone, email };
}

export function hasInvisible(raw: string): boolean {
	const legitimate = raw.replace(EMOJI_JOINER, "$1").replace(FLAG_TAG_SEQUENCE, "");
	return ANY_INVISIBLE.test(legitimate) || TAGS.test(legitimate);
}

export function normalized(raw: string): string {
	return collapse(stripInvisible(decodeEntities(raw).normalize("NFKC")).toLowerCase());
}

function wordsOf(norm: string): string {
	return ` ${norm.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

function hasBase64(text: string): boolean {
	return (text.match(BASE64_RUN) ?? []).some((run) => /[0-9]/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run));
}

function injection(raw: string, clean: string): boolean {
	if (hasInvisible(raw)) return true;
	const norm = normalized(raw);
	if (STEERING.some((pattern) => pattern.test(wordsOf(norm)))) return true;
	if (TEMPLATE_TOKENS.some((token) => norm.includes(token)) || TEMPLATE_ROLE.test(norm)) return true;
	if (FLOOR_INJECTION.test(raw) || FLOOR_INJECTION.test(clean) || FLOOR_INJECTION.test(norm)) return true;
	return hasBase64(stripInvisible(decodeEntities(raw).normalize("NFKC")));
}

function addressed(raw: string): boolean {
	const norm = normalized(raw);
	return ADDRESSED_WORDS.some((pattern) => pattern.test(wordsOf(norm))) || ADDRESSED_MENTION.test(norm);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeTerm(term: string): string {
	return collapse(term.normalize("NFKC").toLowerCase());
}

function blocked(raw: string, blocklist: readonly string[]): boolean {
	const lowered = raw.toLowerCase();
	const norm = normalized(raw);
	return blocklist.some((term) => {
		if (term === "") return false;
		const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, "u");
		return pattern.test(lowered) || pattern.test(norm);
	});
}

export function cleanPostText(raw: string): { text: string; phone: boolean; email: boolean; overlong: boolean } {
	const decoded = decodeEntities(raw).replace(URL, "[link]");
	const first = maskContacts(decoded);
	const second = maskContacts(stripInvisible(first.text.normalize("NFKC")));
	const withoutEmoji = second.text.replace(EMOJI, "");
	const withoutMentions = withoutEmoji.replace(LEADING_MENTIONS, "");
	const { text, cut: overlong } = cut(collapse(withoutMentions), TEXT_CHARS);
	return { text, phone: first.phone || second.phone, email: first.email || second.email, overlong };
}

export function cleanName(raw: string): string {
	return cut(collapse(stripInvisible(decodeEntities(raw).normalize("NFKC")).replace(EMOJI, "")), NAME_CHARS).text;
}

export function validHandle(handle: string | undefined): string {
	return handle !== undefined && HANDLE.test(handle) ? handle : "unknown";
}

export function handleOk(handle: string, blocklist: readonly string[]): boolean {
	if (!HANDLE.test(handle) || handle === "unknown") return false;
	const squashed = handle.toLowerCase().replace(/[^a-z0-9]/g, "");
	return !blocklist.some((term) => {
		const squashedTerm = term.toLowerCase().replace(/[^a-z0-9]/g, "");
		return squashedTerm !== "" && squashed.includes(squashedTerm);
	});
}

export function rejectingFlags(flags: readonly string[]): string[] {
	return flags.filter((flag) => (REJECTING as readonly string[]).includes(flag));
}

export function screen(text: string, name: string, blocklist: readonly string[] = [], handle = "unknown"): Screened {
	const clean = cleanPostText(text);
	const printable = toPrintable(clean.text).trim();
	const found = new Set<Flag>();
	const notes: string[] = [];
	const nameInjection = injection(name, cleanName(name));
	const nameBlocked = blocked(name, blocklist);
	const handleBlocked = handle !== "unknown" && !handleOk(handle, blocklist);
	if (injection(text, clean.text) || nameInjection) found.add("injection");
	if (addressed(text) || addressed(name)) found.add("addressed");
	if (clean.phone) found.add("phone");
	if (clean.email) found.add("email");
	if (blocked(text, blocklist) || nameBlocked || handleBlocked) found.add("blocked");
	if (printable === "" || printable === "[link]" || clean.text === "") found.add("empty");
	if (clean.overlong) found.add("overlong");
	if ((text.match(/@/g) ?? []).length >= 5) found.add("mentions");
	if (text.length > 40 && toPrintable(clean.text).length < text.length * 0.5) found.add("unprintable");
	if (LONG_TOKEN.test(text) && !found.has("injection")) found.add("encoded");
	if (nameInjection) notes.push("injection in the display name");
	if (nameBlocked) notes.push("blocked term in the display name");
	if (handleBlocked) notes.push("blocked term in the handle");
	return { cleanText: clean.text, cleanName: cleanName(name), flags: FLAGS.filter((flag) => found.has(flag)), notes };
}
