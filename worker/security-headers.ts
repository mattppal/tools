const BASE_CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"content-security-policy": BASE_CSP,
	"x-frame-options": "DENY",
	"x-content-type-options": "nosniff",
	"referrer-policy": "strict-origin-when-cross-origin",
	"strict-transport-security": "max-age=31536000",
	"permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

export function pageCsp(nonce: string): string {
	return `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; ${BASE_CSP}`;
}

function newNonce(): string {
	return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
}

export function withScriptNonce(response: Response): Response {
	if (!(response.headers.get("content-type") ?? "").startsWith("text/html")) return response;
	const nonce = newNonce();
	const rewritten = new HTMLRewriter()
		.on("script", {
			element(script) {
				script.setAttribute("nonce", nonce);
			},
		})
		.transform(response);
	const page = new Response(rewritten.body, rewritten);
	page.headers.set("content-security-policy", pageCsp(nonce));
	page.headers.set("cache-control", "no-store");
	page.headers.delete("etag");
	page.headers.delete("last-modified");
	return page;
}

export function withSecurityHeaders(response: Response): Response {
	if (response.status === 101 || response.webSocket) return response;
	const secured = new Response(response.body, response);
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!secured.headers.has(name)) secured.headers.set(name, value);
	return secured;
}
