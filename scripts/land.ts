import { $ } from "bun";
import { MIGRATION_PATH } from "../worker/migrations.ts";
import { createRole, deleteRole, type Role, roleUrl } from "./planetscale.ts";

type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string };
type PullRequest = { number: number; state: string; baseRefName: string; headRefName: string; headRefOid: string; statusCheckRollup: Check[] };

const REQUIRED_CHECK = "checks";
const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const MERGE_WAIT_MS = 60_000;
const ROLE_TTL_SECONDS = 15 * 60;

function stop(message: string): never {
	console.error(`land: ${message}`);
	process.exit(1);
}

async function readPr(number: string): Promise<PullRequest> {
	const json = await $`gh pr view ${number} --json number,state,baseRefName,headRefName,headRefOid,statusCheckRollup`.quiet().nothrow();
	if (json.exitCode !== 0) stop(`gh could not read PR ${number}: ${json.stderr.toString().trim()}`);
	return JSON.parse(json.stdout.toString());
}

function checkName(check: Check): string {
	return check.name ?? check.context ?? "unnamed check";
}

function checkResult(check: Check): string {
	return check.conclusion || check.state || check.status || "PENDING";
}

const number = process.argv[2];
if (number === undefined || !/^\d+$/.test(number)) stop("usage: bun run land <pr-number>");

const pr = await readPr(number);
if (pr.state !== "OPEN") stop(`PR #${pr.number} is ${pr.state.toLowerCase()}. Only an open PR can land.`);
if (pr.baseRefName !== "main") stop(`PR #${pr.number} targets ${pr.baseRefName}. Retarget it to main first.`);

const failing = pr.statusCheckRollup.filter((check) => !PASSING.has(checkResult(check)));
if (failing.length > 0) stop(`PR #${pr.number} has checks that are not green: ${failing.map((check) => `${checkName(check)} (${checkResult(check).toLowerCase()})`).join(", ")}. Wait for them or fix them.`);
if (!pr.statusCheckRollup.some((check) => checkName(check) === REQUIRED_CHECK)) stop(`PR #${pr.number} has no "${REQUIRED_CHECK}" run at its head. Push the head again so CI runs.`);

await $`git fetch --quiet origin main ${pr.headRefName}`;
const fetchedHead = (await $`git rev-parse origin/${pr.headRefName}`.text()).trim();
if (fetchedHead !== pr.headRefOid) stop(`origin/${pr.headRefName} is ${fetchedHead}, but GitHub reports head ${pr.headRefOid}. Retry once GitHub catches up.`);
const rebased = await $`git merge-base --is-ancestor origin/main ${pr.headRefOid}`.nothrow();
if (rebased.exitCode !== 0) stop(`PR #${pr.number} does not contain origin/main. Rebase ${pr.headRefName} onto origin/main, push, and wait for CI.`);

const migrations = (await $`git diff --name-only origin/main ${pr.headRefOid} -- tools`.text()).split("\n").filter((path) => MIGRATION_PATH.test(path));
if (migrations.length > 0) {
	console.log(`land: PR #${pr.number} changes ${migrations.join(", ")}. Migrating preview, then main, from ${pr.headRefOid.slice(0, 7)} before main moves.`);
	for (const branch of ["preview", "main"] as const) {
		let role: Role;
		try {
			role = await createRole(branch, `land-${pr.number}-${Date.now()}`, ROLE_TTL_SECONDS);
		} catch (error) {
			stop(`${error instanceof Error ? error.message : error} PR #${pr.number} changes migrations, which land applies to preview and main before pushing.`);
		}
		const run = await $`bun scripts/migrate.ts --ref ${pr.headRefOid}`.env({ ...process.env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB: roleUrl(role) }).nothrow();
		await deleteRole(branch, role);
		if (run.exitCode !== 0) stop(`migrating ${branch} failed, so main did not move. Fix the migration, push, and land again.`);
	}
}

const push = await $`git push origin ${pr.headRefOid}:refs/heads/main`.nothrow();
if (push.exitCode !== 0) stop(`pushing ${pr.headRefOid} to main failed. Main probably moved; rebase and retry.`);

const deadline = Date.now() + MERGE_WAIT_MS;
while (Date.now() < deadline) {
	const after = await readPr(number);
	if (after.state === "MERGED") {
		console.log(`land: PR #${pr.number} merged as ${pr.headRefOid}.`);
		process.exit(0);
	}
	await Bun.sleep(3_000);
}
stop(`main is at ${pr.headRefOid}, but GitHub has not marked PR #${pr.number} merged after ${MERGE_WAIT_MS / 1000}s. Check the PR page.`);
