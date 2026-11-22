import { expect, test } from "bun:test";
import config from "../wrangler.jsonc";

const BINDING_KEYS = [
	"vars",
	"hyperdrive",
	"version_metadata",
	"kv_namespaces",
	"r2_buckets",
	"d1_databases",
	"services",
	"durable_objects",
	"queues",
	"ai",
	"analytics_engine_datasets",
	"vectorize",
	"browser",
	"images",
	"send_email",
	"secrets_store_secrets",
	"workflows",
	"dispatch_namespaces",
	"mtls_certificates",
	"pipelines",
] as const;

test("previews bind everything production binds", () => {
	const production = BINDING_KEYS.filter((key) => key in config);
	const previews: Record<string, unknown> = config.previews ?? {};
	expect(production.length).toBeGreaterThan(0);
	expect(production.filter((key) => !(key in previews))).toEqual([]);
});

test("every production binding name has a preview binding of the same name", () => {
	const names = (block: Record<string, unknown>, key: string): string[] => {
		const value = block[key];
		if (Array.isArray(value)) return value.map((item: { binding?: string; name?: string }) => item.binding ?? item.name ?? "").toSorted();
		if (value !== null && typeof value === "object") return "binding" in value ? [String(value.binding)] : Object.keys(value).toSorted();
		return [];
	};
	const previews: Record<string, unknown> = config.previews ?? {};
	for (const key of BINDING_KEYS.filter((key) => key in config)) expect({ key, names: names(previews, key) }).toEqual({ key, names: names(config, key) });
});
