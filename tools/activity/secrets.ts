const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SALT = encoder.encode("tools-withings");
const STATE_TTL_MS = 15 * 60_000;

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function derive(secret: string, info: string, algorithm: AesKeyGenParams | HmacImportParams, usages: KeyUsage[]): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: SALT, info: encoder.encode(info) }, base, algorithm, false, usages);
}

const tokenKey = (secret: string) => derive(secret, "token", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]);
const stateKey = (secret: string) => derive(secret, "state", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign", "verify"]);

export async function seal(secret: string, plain: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(secret), encoder.encode(plain)));
	return `v1.${base64url(iv)}.${base64url(sealed)}`;
}

export async function unseal(secret: string, sealed: string): Promise<string> {
	const [version, iv, data] = sealed.split(".");
	if (version !== "v1" || iv === undefined || data === undefined) throw new Error("Stored Withings token has an unknown format");
	return decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(iv) }, await tokenKey(secret), fromBase64url(data)));
}

export async function signState(secret: string, now = Date.now()): Promise<string> {
	const payload = `${now + STATE_TTL_MS}.${base64url(crypto.getRandomValues(new Uint8Array(16)))}`;
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await stateKey(secret), encoder.encode(payload)));
	return `${payload}.${base64url(signature)}`;
}

export async function verifyState(secret: string, state: string, now = Date.now()): Promise<boolean> {
	const [expires, nonce, signature] = state.split(".");
	if (expires === undefined || nonce === undefined || signature === undefined || !(Number(expires) > now)) return false;
	try {
		return await crypto.subtle.verify("HMAC", await stateKey(secret), fromBase64url(signature), encoder.encode(`${expires}.${nonce}`));
	} catch {
		return false;
	}
}
