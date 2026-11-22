export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"content-security-policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
	"x-frame-options": "DENY",
	"x-content-type-options": "nosniff",
	"referrer-policy": "strict-origin-when-cross-origin",
	"strict-transport-security": "max-age=31536000",
	"permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

export function withSecurityHeaders(response: Response): Response {
	if (response.status === 101 || response.webSocket) return response;
	const secured = new Response(response.body, response);
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!secured.headers.has(name)) secured.headers.set(name, value);
	return secured;
}
