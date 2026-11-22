import { expect, test } from "bun:test";
import { requireBot } from "./bot-auth.ts";

const NUTRITION = "nutrition-token-7f3a";
const COACH = "coach-token-91bc";
const env = { BOT_TOKEN_NUTRITION: NUTRITION, BOT_TOKEN_COACH: COACH } as Env;

function call(authorization: string | null): Request {
	return new Request("https://tools.example/api/tools/nutrition/mcp", { method: "POST", headers: authorization === null ? {} : { authorization } });
}

async function denied(result: Promise<unknown>): Promise<void> {
	const response = await result;
	expect(response).toBeInstanceOf(Response);
	if (!(response instanceof Response)) return;
	expect(response.status).toBe(401);
	expect(response.headers.get("www-authenticate")).toBe('Bearer realm="tools"');
}

test("each bot's token opens only its own tools", async () => {
	expect(await requireBot(call(`Bearer ${NUTRITION}`), env, "nutrition")).toBe("nutrition");
	expect(await requireBot(call(`Bearer ${COACH}`), env, "workouts")).toBe("coach");
	await denied(requireBot(call(`Bearer ${COACH}`), env, "nutrition"));
	await denied(requireBot(call(`Bearer ${NUTRITION}`), env, "workouts"));
	await denied(requireBot(call(`Bearer ${NUTRITION}`), env, "notes"));
});

test("accepts the scheme in any case", async () => {
	expect(await requireBot(call(`bearer ${NUTRITION}`), env, "nutrition")).toBe("nutrition");
});

test("rejects a missing header, another scheme, a bare token, and a near miss", async () => {
	await denied(requireBot(call(null), env, "nutrition"));
	await denied(requireBot(call(NUTRITION), env, "nutrition"));
	await denied(requireBot(call(`Basic ${NUTRITION}`), env, "nutrition"));
	await denied(requireBot(call("Bearer "), env, "nutrition"));
	await denied(requireBot(call(`Bearer ${NUTRITION.slice(0, -1)}`), env, "nutrition"));
	await denied(requireBot(call(`Bearer ${NUTRITION}x`), env, "nutrition"));
	await denied(requireBot(call(`Bearer ${NUTRITION} extra`), env, "nutrition"));
});

test("an unset or empty secret lets nobody in", async () => {
	await denied(requireBot(call(`Bearer ${NUTRITION}`), {} as Env, "nutrition"));
	await denied(requireBot(call("Bearer undefined"), {} as Env, "nutrition"));
	await denied(requireBot(call("Bearer x"), { BOT_TOKEN_NUTRITION: "" } as Env, "nutrition"));
});
