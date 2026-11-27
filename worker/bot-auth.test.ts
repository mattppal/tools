import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { BOTS, type BotName, type Caller } from "./access.ts";
import { type BotAuthLine, requireBot } from "./bot-auth.ts";

const SECRETS = { BOT_TOKEN_NUTRITION: "nutrition-token-7f3a", BOT_TOKEN_COACH: "coach-token-91bc", BOT_TOKEN_COORDINATOR: "coordinator-token-2d0e", BOT_TOKEN_APPLE_HEALTH: "apple-token-5c2e" };
const env = SECRETS as Env;
const TOKEN: Partial<Record<BotName, string>> = { nutrition: SECRETS.BOT_TOKEN_NUTRITION, coach: SECRETS.BOT_TOKEN_COACH, coordinator: SECRETS.BOT_TOKEN_COORDINATOR, "apple-health": SECRETS.BOT_TOKEN_APPLE_HEALTH };
const OWNER: Caller = { kind: "owner", email: "mattppalmer@gmail.com" };
const LOCAL: Caller = { kind: "local" };
const bot = (name: BotName): Caller => ({ kind: "bot", bot: name });

const ROUTES = [
	["nutrition", "POST /mcp"],
	["workouts", "POST /sync"],
	["liaison", "POST /notices"],
	["liaison", "GET /deliveries"],
	["activity", "GET /days"],
	["activity", "GET /weights"],
	["activity", "GET /health"],
	["activity", "GET /workouts"],
	["activity", "GET /sleep"],
	["activity", "GET /measures"],
	["activity", "GET /intraday"],
	["activity", "POST /apple-health"],
	["goals", "GET /goals"],
	["notes", "GET /"],
	["x-posts", "GET /mentions"],
	["x-posts", "POST /mentions/reply"],
] as const;

const GRANTS: Record<BotName, readonly string[]> = {
	nutrition: ["nutrition POST /mcp", "activity GET /days", "activity GET /weights", "activity GET /health", "activity GET /sleep"],
	coach: ["workouts POST /sync", "activity GET /workouts"],
	coordinator: ["liaison POST /notices", "liaison GET /deliveries"],
	smoke: ["nutrition POST /mcp", "activity GET /days", "activity GET /weights", "activity GET /health", "activity GET /workouts", "activity GET /sleep", "activity GET /measures", "activity GET /intraday"],
	"apple-health": ["activity POST /apple-health"],
	gtd: ["goals GET /goals"],
};

let logged: BotAuthLine[] = [];
let spy: ReturnType<typeof spyOn>;

beforeEach(() => {
	logged = [];
	spy = spyOn(console, "log").mockImplementation((line: string) => void logged.push(JSON.parse(line) as BotAuthLine));
});

afterEach(() => spy.mockRestore());

function call(route: string, authorization: string | null = null): Request {
	const [method = "GET"] = route.split(" ");
	return new Request("https://tools.example/api/tools/x", { method, headers: authorization === null ? {} : { authorization } });
}

async function outcome(caller: Caller, tool: string, route: string, authorization: string | null = null): Promise<BotName | number> {
	const result = await requireBot(call(route, authorization), { env, caller, path: route.split(" ")[1] ?? "/" }, tool);
	return result instanceof Response ? result.status : result;
}

test("each bot's Access identity alone opens exactly its registry scopes", async () => {
	for (const name of Object.keys(BOTS) as BotName[]) {
		for (const [tool, route] of ROUTES) {
			const expected = GRANTS[name].includes(`${tool} ${route}`) ? name : 403;
			expect({ name, tool, route, result: await outcome(bot(name), tool, route) }).toEqual({ name, tool, route, result: expected });
		}
	}
});

test("during the window, each bearer alone opens the same scopes as its bot's identity", async () => {
	for (const [name, token] of Object.entries(TOKEN) as [BotName, string][]) {
		for (const [tool, route] of ROUTES) {
			const expected = GRANTS[name].includes(`${tool} ${route}`) ? name : 403;
			expect({ name, tool, route, result: await outcome(LOCAL, tool, route, `Bearer ${token}`) }).toEqual({ name, tool, route, result: expected });
		}
	}
});

test("smoke and gtd have no bearer, and gtd reaches only goals", () => {
	expect(BOTS.smoke).toMatchObject({ serviceToken: "tools-agent-verify", clientId: "3764ccd9a5d87214d1032418b8c228ed.access", bearer: null });
	expect(BOTS.gtd).toEqual({ serviceToken: "gtd-bot", clientId: "acfc8c269c4412bc69e52f3f59d9d965.access", bearer: null, tools: { goals: "all" } });
});

test("logs which credential let the bot in, by name only", async () => {
	expect(await outcome(bot("nutrition"), "nutrition", "POST /mcp")).toBe("nutrition");
	expect(await outcome(bot("nutrition"), "nutrition", "POST /mcp", `Bearer ${SECRETS.BOT_TOKEN_NUTRITION}`)).toBe("nutrition");
	expect(await outcome(bot("smoke"), "liaison", "POST /notices", `Bearer ${SECRETS.BOT_TOKEN_COORDINATOR}`)).toBe("coordinator");
	expect(await outcome(LOCAL, "workouts", "POST /sync", `Bearer ${SECRETS.BOT_TOKEN_COACH}`)).toBe("coach");
	expect(await outcome(bot("coach"), "workouts", "POST /sync", "Bearer stale")).toBe("coach");
	expect(logged).toEqual([
		{ auth: "bot", tool: "nutrition", route: "POST /mcp", bot: "nutrition", via: "access", access: "nutrition", bearer: "absent" },
		{ auth: "bot", tool: "nutrition", route: "POST /mcp", bot: "nutrition", via: "access", access: "nutrition", bearer: "nutrition" },
		{ auth: "bot", tool: "liaison", route: "POST /notices", bot: "coordinator", via: "bearer", access: "smoke", bearer: "coordinator" },
		{ auth: "bot", tool: "workouts", route: "POST /sync", bot: "coach", via: "bearer", access: null, bearer: "coach" },
		{ auth: "bot", tool: "workouts", route: "POST /sync", bot: "coach", via: "access", access: "coach", bearer: "unmatched" },
	]);
	for (const secret of [...Object.values(SECRETS), "stale"]) expect(JSON.stringify(logged)).not.toContain(secret);
});

test("no bot credential gets a 401; a bot outside its scope gets a 403 naming it", async () => {
	for (const caller of [OWNER, LOCAL, { kind: "public" } as Caller]) {
		const response = await requireBot(call("POST /mcp"), { env, caller, path: "/mcp" }, "nutrition");
		if (!(response instanceof Response)) throw new Error("expected a refusal");
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe('Bearer realm="tools"');
	}
	const refused = await requireBot(call("GET /intraday"), { env, caller: bot("nutrition"), path: "/intraday" }, "activity");
	if (!(refused instanceof Response)) throw new Error("expected a refusal");
	expect(refused.status).toBe(403);
	expect(await refused.json()).toEqual({ error: "Forbidden: bot nutrition may not call GET /intraday on activity" });
});

test("rejects another scheme, a bare token, and near misses", async () => {
	const token = SECRETS.BOT_TOKEN_NUTRITION;
	for (const header of [token, `Basic ${token}`, "Bearer ", `Bearer ${token.slice(0, -1)}`, `Bearer ${token}x`, `Bearer ${token} extra`]) {
		expect({ header, result: await outcome(LOCAL, "nutrition", "POST /mcp", header) }).toEqual({ header, result: 401 });
	}
	expect(await outcome(LOCAL, "nutrition", "POST /mcp", `bearer ${token}`)).toBe("nutrition");
});

test("an unset or empty secret lets no bearer in", async () => {
	const without = async (secrets: Partial<typeof SECRETS>, header: string) => {
		const result = await requireBot(call("POST /mcp", header), { env: secrets as Env, caller: LOCAL, path: "/mcp" }, "nutrition");
		return result instanceof Response ? result.status : result;
	};
	expect(await without({}, `Bearer ${SECRETS.BOT_TOKEN_NUTRITION}`)).toBe(401);
	expect(await without({}, "Bearer undefined")).toBe(401);
	expect(await without({ BOT_TOKEN_NUTRITION: "" }, "Bearer x")).toBe(401);
});

test("a tool slug that names an Object property grants nothing", async () => {
	for (const tool of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
		expect({ tool, result: await outcome(bot("nutrition"), tool, "GET /") }).toEqual({ tool, result: 403 });
	}
});
