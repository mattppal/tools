declare const TOOLS_BUILD: string;

type Lifecycle = Event & { waitUntil: (work: Promise<unknown>) => void };
type Fetching = Lifecycle & { request: Request; respondWith: (response: Promise<Response>) => void };
type Scope = {
	location: Location;
	skipWaiting: () => Promise<void>;
	clients: { claim: () => Promise<void> };
	addEventListener: ((type: "install" | "activate", listener: (event: Lifecycle) => void) => void) & ((type: "fetch", listener: (event: Fetching) => void) => void);
};

function isScope(value: unknown): value is Scope {
	return typeof value === "object" && value !== null && "skipWaiting" in value && "clients" in value && "addEventListener" in value;
}

const candidate: unknown = globalThis;
if (!isScope(candidate)) throw new Error("sw.js runs only as a service worker");
const scope = candidate;

const ASSETS_CACHE = "tools-assets";
const STATIC_CACHE = `tools-static-${TOOLS_BUILD}`;
const ASSET_LIMIT = 300;
const STATIC = /^\/(?:icon-[\w-]+|apple-touch-icon|favicon-\d+)\.png$/;

const OFFLINE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f4f3f1">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1a1917">
<title>Offline · Tools</title>
<style>
body{margin:0;display:grid;place-items:center;min-height:100dvh;padding:24px;box-sizing:border-box;font:390 15px/22px Inter,system-ui,-apple-system,sans-serif;background:light-dark(#f4f3f1,#1a1917);color:light-dark(#171613,#efebe5);color-scheme:light dark;-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
main{max-width:320px;text-align:center}
h1{margin:0 0 6px;font-size:22px;line-height:28px;font-weight:540;letter-spacing:-0.01em}
p{margin:0 0 20px;color:light-dark(#4a4946,#aba49a)}
button{min-height:44px;padding:0 18px;border:0;border-radius:10px;background:light-dark(#e8e6e4,#2e2d2a);color:inherit;font:inherit;font-weight:500;cursor:pointer;transition:transform 160ms cubic-bezier(0.23,1,0.32,1)}
button:active{transform:scale(0.97)}
</style>
</head>
<body>
<main>
<h1>You’re offline</h1>
<p>Tools reconnects on its own when your connection comes back.</p>
<button type="button" onclick="location.reload()">Try again</button>
</main>
<script>addEventListener("online",function(){location.reload()})</script>
</body>
</html>`;

function cacheable(response: Response): boolean {
	return response.ok && response.type === "basic" && !response.redirected;
}

async function navigate(request: Request): Promise<Response> {
	try {
		return await fetch(request);
	} catch {
		return new Response(OFFLINE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
	}
}

async function trim(cache: Cache): Promise<void> {
	const keys = await cache.keys();
	await Promise.all(keys.slice(0, Math.max(0, keys.length - ASSET_LIMIT)).map((key) => cache.delete(key)));
}

async function cacheFirst(request: Request, event: Lifecycle): Promise<Response> {
	const cache = await caches.open(ASSETS_CACHE);
	const cached = await cache.match(request);
	if (cached !== undefined) return cached;
	const response = await fetch(request);
	if (cacheable(response)) event.waitUntil(cache.put(request, response.clone()).then(() => trim(cache)));
	return response;
}

async function staleWhileRevalidate(request: Request, event: Lifecycle): Promise<Response> {
	const cache = await caches.open(STATIC_CACHE);
	const cached = await cache.match(request);
	const fresh = fetch(request)
		.then(async (response) => {
			if (cacheable(response)) await cache.put(request, response.clone());
			return response;
		})
		.catch(() => undefined);
	event.waitUntil(fresh);
	return cached ?? (await fresh) ?? Response.error();
}

scope.addEventListener("install", () => {
	void scope.skipWaiting();
});

scope.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((names) => Promise.all(names.filter((name) => name.startsWith("tools-static-") && name !== STATIC_CACHE).map((name) => caches.delete(name))))
			.then(() => scope.clients.claim()),
	);
});

scope.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== scope.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/cdn-cgi/")) return;
	if (request.mode === "navigate") return event.respondWith(navigate(request));
	if (url.pathname.startsWith("/assets/")) return event.respondWith(cacheFirst(request, event));
	if (STATIC.test(url.pathname)) return event.respondWith(staleWhileRevalidate(request, event));
});
