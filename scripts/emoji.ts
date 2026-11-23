const ONE_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");

export function isEmoji(text: string): boolean {
	return ONE_EMOJI.test(text);
}
