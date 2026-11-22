export const REPLY_MAX = 280;

const URL_WEIGHT = 23;
const URL = /https?:\/\/\S+/gi;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const LIGHT: readonly [number, number][] = [
	[0, 4351],
	[8192, 8205],
	[8208, 8223],
	[8242, 8247],
];
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function weigh(text: string): number {
	let total = 0;
	for (const { segment } of segmenter.segment(text)) {
		if (PICTOGRAPH.test(segment)) {
			total += 2;
			continue;
		}
		for (const char of segment) {
			const code = char.codePointAt(0) ?? 0;
			total += LIGHT.some(([from, to]) => code >= from && code <= to) ? 1 : 2;
		}
	}
	return total;
}

export function replyLength(text: string): number {
	const normalized = text.normalize("NFC");
	const urls = normalized.match(URL) ?? [];
	return weigh(normalized.replace(URL, "")) + urls.length * URL_WEIGHT;
}

export function isSendKey(event: { key: string; metaKey: boolean; ctrlKey: boolean }, mac: boolean): boolean {
	return event.key === "Enter" && (mac ? event.metaKey : event.ctrlKey);
}
