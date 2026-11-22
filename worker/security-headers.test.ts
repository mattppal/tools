import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SECURITY_HEADERS, withSecurityHeaders } from "./security-headers.ts";

function staticHeaders(): Record<string, string> {
	const text = readFileSync(resolve(import.meta.dirname, "../public/_headers"), "utf8");
	const block = text.split(/\n(?=\S)/).find((section) => section.startsWith("/*\n")) ?? "";
	return Object.fromEntries(
		block
			.split("\n")
			.slice(1)
			.map((line) => line.trim())
			.filter((line) => line !== "")
			.map((line) => {
				const at = line.indexOf(":");
				return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
			}),
	);
}

test("public/_headers sends the same security headers as Worker responses", () => {
	expect(staticHeaders()).toEqual({ ...SECURITY_HEADERS });
});

test("adds every security header and keeps a header the response already set", async () => {
	const response = withSecurityHeaders(new Response("{}", { status: 201, headers: { "content-type": "application/json", "referrer-policy": "no-referrer" } }));
	expect(response.status).toBe(201);
	expect(await response.text()).toBe("{}");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (name !== "referrer-policy") expect(response.headers.get(name)).toBe(value);
});
