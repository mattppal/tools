import { $ } from "bun";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const MODEL_DIR = join(ROOT, "skills/tools-verify-webhooks");
const TLC_VERSION = "1.7.4";
const TLC_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLC_VERSION}/tla2tools.jar`;
const TLC_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const TLC_JAR = join(ROOT, `node_modules/.cache/tla/tla2tools-${TLC_VERSION}.jar`);

type Run = { config: string; design: string; violates: string | null };

const RUNS: Run[] = [
	{ config: "claim.cfg", design: "worker/webhooks.ts today: a fenced claim that expires after its holder stops", violates: null },
	{ config: "claim-slow.cfg", design: "the same claim when a send outlives its lease: the fence keeps the newer result", violates: null },
	{ config: "claim-nofence-slow.cfg", design: "a claim whose result is recorded without checking claim_id", violates: "DeliveredStaysDelivered" },
	{ config: "select.cfg", design: "the workouts draft before claims: a plain select, then send", violates: "NoConcurrentSends" },
	{ config: "lease.cfg", design: "main before claims: a 5-minute lease that the first attempt and Send again ignore", violates: "NoConcurrentSends" },
	{ config: "lease-stale.cfg", design: "the same lease: a later failed send clears a recorded success", violates: "DeliveredStaysDelivered" },
];

async function tlcJar(): Promise<string> {
	if (!existsSync(TLC_JAR)) {
		await mkdir(join(TLC_JAR, ".."), { recursive: true });
		const response = await fetch(TLC_URL);
		if (!response.ok) throw new Error(`Downloading TLC ${TLC_VERSION} failed with HTTP ${response.status}`);
		await Bun.write(TLC_JAR, await response.arrayBuffer());
	}
	const hash = createHash("sha256").update(await readFile(TLC_JAR)).digest("hex");
	if (hash !== TLC_SHA256) {
		await rm(TLC_JAR);
		throw new Error(`${TLC_JAR} has sha256 ${hash}, expected ${TLC_SHA256}. Deleted it; rerun to download again.`);
	}
	return TLC_JAR;
}

if ((await $`java -version`.quiet().nothrow()).exitCode !== 0) {
	console.error("verify:webhooks needs Java 11 or newer on PATH to run TLC.");
	process.exit(1);
}

const jar = await tlcJar();
let failed = false;
for (const run of RUNS) {
	const metadir = await mkdtemp(join(tmpdir(), "tlc-"));
	const result = await $`java -XX:+UseParallelGC -cp ${jar} tlc2.TLC -config ${run.config} -workers auto -metadir ${metadir} -cleanup delivery.tla`.cwd(MODEL_DIR).quiet().nothrow();
	await rm(metadir, { recursive: true, force: true });
	const output = result.stdout.toString();
	const violated = /Invariant (\w+) is violated/.exec(output)?.[1] ?? null;
	const passed = output.includes("Model checking completed. No error has been found.");
	const states = /(\d+) distinct states found/.exec(output)?.[1] ?? "?";
	if (!passed && violated === null) {
		console.error(`${run.config}: TLC did not finish.\n${output}${result.stderr.toString()}`);
		failed = true;
	} else if (run.violates === null && violated !== null) {
		console.error(`${run.config}: ${violated} is violated in ${run.design}.\n${output}`);
		failed = true;
	} else if (run.violates !== null && violated !== run.violates) {
		console.error(`${run.config}: expected ${run.violates} to fail for ${run.design}, but ${violated ?? "every invariant held"}. The model no longer catches this past bug.`);
		failed = true;
	} else {
		console.log(`${run.config}: ${run.violates === null ? `all invariants hold over ${states} states` : `${run.violates} fails as expected`} (${run.design})`);
	}
}
process.exit(failed ? 1 : 0);
