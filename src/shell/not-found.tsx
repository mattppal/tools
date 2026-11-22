import { buttonVariants } from "../kit/button.tsx";
import { TOOLS, type Tool } from "../registry.ts";
import { Link, usePath } from "../router.tsx";
import styles from "./home.module.css";
import { Icon } from "./icons.tsx";
import { ToolLayout } from "./tool-layout.tsx";

function distance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}

function closest(path: string): Tool | undefined {
	const slug = (path.split("/")[1] ?? "").toLowerCase();
	if (slug === "") return undefined;
	const ranked = TOOLS.map((tool) => ({ tool, score: distance(slug, tool.slug) })).toSorted((a, b) => a.score - b.score);
	const best = ranked[0];
	if (best === undefined) return undefined;
	return best.score <= Math.max(1, Math.floor(best.tool.slug.length / 3)) ? best.tool : undefined;
}

export function NotFound() {
	const path = usePath();
	const suggestion = closest(path);
	return (
		<ToolLayout title="Not found">
			<div className={styles.missing}>
				<span className={styles.missingIcon}>
					<Icon name="search" size={20} />
				</span>
				<h2 className={styles.missingTitle}>No tool here</h2>
				<p className={styles.missingText}>
					Nothing lives at <code className={styles.path}>{path}</code>. The link may be mistyped, or the tool was renamed.
				</p>
				<div className={styles.missingActions}>
					{suggestion === undefined ? null : (
						<Link href={`/${suggestion.slug}`} className={buttonVariants({ variant: "primary" })}>
							<Icon name={suggestion.icon ?? "tool"} />
							Open {suggestion.name}
						</Link>
					)}
					<Link href="/" className={buttonVariants({ variant: suggestion === undefined ? "primary" : "secondary" })}>
						<Icon name="back" />
						All tools
					</Link>
				</div>
			</div>
		</ToolLayout>
	);
}
