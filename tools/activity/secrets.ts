const encoder = new TextEncoder();
const decoder = new TextDecoder();
const STATE_TTL_MS = 15 * 60_000;

export function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export type Secrets = {
	seal: (secret: string, plain: string) => Promise<string>;
	unseal: (secret: string, sealed: string) => Promise<string>;
	signState: (secret: string, now?: number) => Promise<string>;
	verifyState: (secret: string, state: string, now?: number) => Promise<boolean>;
};

export function secrets(saltText: string, label: string): Secrets {
	const salt = encoder.encode(saltText);
	async function derive(secret: string, info: string, algorithm: AesKeyGenParams | HmacImportParams, usages: KeyUsage[]): Promise<CryptoKey> {
		const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
		return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(info) }, base, algorithm, false, usages);
	}
	const tokenKey = (secret: string) => derive(secret, "token", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]);
	const stateKey = (secret: string) => derive(secret, "state", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign", "verify"]);
	return {
		async seal(secret, plain) {
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(secret), encoder.encode(plain)));
			return `v1.${base64url(iv)}.${base64url(sealed)}`;
		},
		async unseal(secret, sealed) {
			const [version, iv, data] = sealed.split(".");
			if (version !== "v1" || iv === undefined || data === undefined) throw new Error(`Stored ${label} token has an unknown format`);
			return decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(iv) }, await tokenKey(secret), fromBase64url(data)));
		},
		async signState(secret, now = Date.now()) {
			const payload = `${now + STATE_TTL_MS}.${base64url(crypto.getRandomValues(new Uint8Array(16)))}`;
			const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await stateKey(secret), encoder.encode(payload)));
			return `${payload}.${base64url(signature)}`;
		},
		async verifyState(secret, state, now = Date.now()) {
			const [expires, nonce, signature] = state.split(".");
			if (expires === undefined || nonce === undefined || signature === undefined || !(Number(expires) > now)) return false;
			try {
				return await crypto.subtle.verify("HMAC", await stateKey(secret), fromBase64url(signature), encoder.encode(`${expires}.${nonce}`));
			} catch {
				return false;
			}
		},
	};
}

export const { seal, unseal, signState, verifyState } = secrets("tools-withings", "Withings");
