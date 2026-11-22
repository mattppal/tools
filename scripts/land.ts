import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { MIGRATION_PATH } from "../worker/migrations.ts";
import { drop, dropNow, enqueue, listTickets, type Ticket } from "./land-queue.ts";
import { createRole, deleteRole, type Role, roleUrl } from "./planetscale.ts";

type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string };
type PullRequest = { number: number; state: string; baseRefName: string; headRefName: string; headRefOid: string; statusCheckRollup: Check[] };

const REQUIRED_CHECK = "checks";
const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const RUNNING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);
const MERGE_WAIT_MS = 60_000;
const CI_WAIT_MS = 25 * 60_000;
const TURN_LIMIT_MS = 40 * 60_000;
const POLL_MS = 15_000;
const ROUNDS = 3;
const ROLE_TTL_SECONDS = 15 * 60;

class Stop extends Error {}

function stop(message: string): never {
	throw new Stop(message);
}

async function readPr(number: number): Promise<PullRequest> {
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

function failed(checks: Check[]): string[] {
	return checks.filter((check) => !PASSING.has(checkResult(check)) && !RUNNING.has(checkResult(check))).map((check) => `${checkName(check)} (${checkResult(check).toLowerCase()})`);
}

async function waitTurn(ticket: Ticket, sha: string): Promise<void> {
	let first: { ref: string; since: number } | undefined;
	let said = "";
	for (;;) {
		const tickets = await listTickets();
		if (!tickets.some((held) => held.ref === ticket.ref)) await $`git push --quiet origin ${`${sha}:${ticket.ref}`}`.quiet();
		const head = tickets[0];
		if (head === undefined || head.ref === ticket.ref) return;
		if (first?.ref !== head.ref) first = { ref: head.ref, since: Date.now() };
		const headPr = await readPr(head.pr);
		if (headPr.state !== "OPEN" || Date.now() - first.since > TURN_LIMIT_MS) {
			console.log(`land: dropping #${head.pr}'s turn (${headPr.state === "OPEN" ? `first for over ${TURN_LIMIT_MS / 60_000} minutes` : headPr.state.toLowerCase()}).`);
			await drop(head);
			continue;
		}
		const ahead = tickets.slice(0, tickets.findIndex((held) => held.ref === ticket.ref)).map((held) => `#${held.pr}`);
		const line = `land: #${ticket.pr} waits behind ${ahead.join(", ")}.`;
		if (line !== said) console.log(line);
		said = line;
		await Bun.sleep(POLL_MS);
	}
}

async function rebase(pr: PullRequest): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `land-${pr.number}-`));
	await $`git worktree add --quiet --detach ${dir} ${pr.headRefOid}`.quiet();
	try {
		const rebased = await $`git -C ${dir} rebase --quiet origin/main`.quiet().nothrow();
		if (rebased.exitCode !== 0) {
			await $`git -C ${dir} rebase --abort`.quiet().nothrow();
			stop(`${pr.headRefName} does not rebase cleanly onto origin/main. Rebase it by hand, push, and land again.`);
		}
		const sha = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
		const push = await $`git push --quiet --force-with-lease=${`refs/heads/${pr.headRefName}:${pr.headRefOid}`} origin ${`${sha}:refs/heads/${pr.headRefName}`}`.quiet().nothrow();
		if (push.exitCode !== 0) stop(`pushing the rebased ${pr.headRefName} failed: ${push.stderr.toString().trim()}`);
		console.log(`land: rebased #${pr.number} onto origin/main as ${sha.slice(0, 7)}; waiting for CI.`);
		return sha;
	} finally {
		await $`git worktree remove --force ${dir}`.quiet().nothrow();
	}
}

async function waitForChecks(number: number, from: string, sha: string, expected: string[]): Promise<PullRequest> {
	const deadline = Date.now() + CI_WAIT_MS;
	while (Date.now() < deadline) {
		const pr = await readPr(number);
		if (pr.headRefOid !== sha && pr.headRefOid !== from) stop(`#${number}'s head moved to ${pr.headRefOid.slice(0, 7)} while it held the queue. Land again.`);
		if (pr.headRefOid === sha) {
			const bad = failed(pr.statusCheckRollup);
			if (bad.length > 0) stop(`#${number} has checks that failed at ${sha.slice(0, 7)}: ${bad.join(", ")}. Fix them and land again.`);
			const names = new Set(pr.statusCheckRollup.map(checkName));
			const done = pr.statusCheckRollup.every((check) => PASSING.has(checkResult(check)));
			if (done && [REQUIRED_CHECK, ...expected].every((name) => names.has(name))) return pr;
		}
		await Bun.sleep(POLL_MS);
	}
	stop(`#${number}'s checks at ${sha.slice(0, 7)} did not finish green within ${CI_WAIT_MS / 60_000} minutes.`);
}

async function migrate(pr: PullRequest): Promise<void> {
	const migrations = (await $`git diff --name-only origin/main ${pr.headRefOid} -- tools`.text()).split("\n").filter((path) => MIGRATION_PATH.test(path));
	if (migrations.length === 0) return;
	console.log(`land: PR #${pr.number} changes ${migrations.join(", ")}. Migrating preview, then main, from ${pr.headRefOid.slice(0, 7)} before main moves.`);
	for (const branch of ["preview", "main"] as const) {
		let role: Role;
		try {
			role = await createRole(branch, `land-${pr.number}-${Date.now()}`, "migrate", ROLE_TTL_SECONDS);
		} catch (error) {
			stop(`${error instanceof Error ? error.message : error} PR #${pr.number} changes migrations, which land applies to preview and main before pushing.`);
		}
		const run = await $`bun scripts/migrate.ts --ref ${pr.headRefOid}`.env({ ...process.env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB: roleUrl(role) }).nothrow();
		await deleteRole(branch, role);
		if (run.exitCode !== 0) stop(`migrating ${branch} failed, so main did not move. Fix the migration, push, and land again.`);
	}
}

async function landHoldingQueue(number: number): Promise<void> {
	for (let round = 1; round <= ROUNDS; round++) {
		let pr = await readPr(number);
		await $`git fetch --quiet origin main ${pr.headRefName}`;
		const fetchedHead = (await $`git rev-parse origin/${pr.headRefName}`.text()).trim();
		if (fetchedHead !== pr.headRefOid) stop(`origin/${pr.headRefName} is ${fetchedHead}, but GitHub reports head ${pr.headRefOid}. Retry once GitHub catches up.`);
		const expected = [...new Set(pr.statusCheckRollup.map(checkName))];
		const current = (await $`git merge-base --is-ancestor origin/main ${pr.headRefOid}`.nothrow()).exitCode === 0;
		const sha = current ? pr.headRefOid : await rebase(pr);
		pr = await waitForChecks(number, pr.headRefOid, sha, expected);
		await migrate(pr);
		const push = await $`git push origin ${pr.headRefOid}:refs/heads/main`.nothrow();
		if (push.exitCode === 0) return waitForMerge(pr);
		console.log(`land: main moved under #${number} (round ${round} of ${ROUNDS}); rebasing again.`);
	}
	stop(`main moved ${ROUNDS} times while #${number} held the queue. Something is pushing to main without bun run land.`);
}

async function waitForMerge(pr: PullRequest): Promise<void> {
	const deadline = Date.now() + MERGE_WAIT_MS;
	while (Date.now() < deadline) {
		if ((await readPr(pr.number)).state === "MERGED") {
			console.log(`land: PR #${pr.number} merged as ${pr.headRefOid}.`);
			return;
		}
		await Bun.sleep(3_000);
	}
	stop(`main is at ${pr.headRefOid}, but GitHub has not marked PR #${pr.number} merged after ${MERGE_WAIT_MS / 1000}s. Check the PR page.`);
}

async function land(arg: string | undefined): Promise<void> {
	if (arg === undefined || !/^\d+$/.test(arg)) stop("usage: bun run land <pr-number>");
	const pr = await readPr(Number(arg));
	if (pr.state !== "OPEN") stop(`PR #${pr.number} is ${pr.state.toLowerCase()}. Only an open PR can land.`);
	if (pr.baseRefName !== "main") stop(`PR #${pr.number} targets ${pr.baseRefName}. Retarget it to main first.`);
	const bad = failed(pr.statusCheckRollup);
	if (bad.length > 0) stop(`PR #${pr.number} has checks that failed: ${bad.join(", ")}. Fix them first.`);
	const ticket = await enqueue(pr.number, pr.headRefOid);
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			dropNow(ticket);
			process.exit(130);
		});
	}
	try {
		await waitTurn(ticket, pr.headRefOid);
		await landHoldingQueue(pr.number);
	} finally {
		await drop(ticket);
	}
}

try {
	await land(process.argv[2]);
} catch (error) {
	if (!(error instanceof Stop)) throw error;
	console.error(`land: ${error.message}`);
	process.exit(1);
}
