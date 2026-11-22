import { TOOLS } from "../registry.ts";
import { Link } from "../router.tsx";
import { useHealth } from "./health.ts";
import styles from "./home.module.css";
import { Icon } from "./icons.tsx";
import { ToolLayout } from "./tool-layout.tsx";

function DbStatus() {
	const health = useHealth();
	switch (health.state) {
		case "checking":
			return <p className={styles.status}>Checking database…</p>;
		case "ok":
			return (
				<p className={styles.status} data-state="ok">
					<Icon name="database" /> Database connected · {health.latencyMs} ms
				</p>
			);
		case "down":
			return (
				<p className={styles.status} data-state="down">
					<Icon name="alert" /> Database unreachable
				</p>
			);
		default: {
			const never: never = health;
			return never;
		}
	}
}

export function Home() {
	return (
		<ToolLayout title="Home">
			<div className={styles.page}>
				<section className={styles.intro}>
					<h2 className={styles.heading}>Tools</h2>
					<p className={styles.lede}>Small utilities, one place. Pick a tool to get started.</p>
					<DbStatus />
				</section>
				<ul className={styles.grid}>
					{TOOLS.map((tool) => (
						<li key={tool.slug}>
							<Link href={`/${tool.slug}`} className={styles.card}>
								<span className={styles.cardIcon}>
									<Icon name={tool.icon ?? "tool"} size={20} />
								</span>
								<span className={styles.cardText}>
									<span className={styles.cardName}>{tool.name}</span>
									<span className={styles.cardDescription}>{tool.description}</span>
								</span>
								<Icon name="chevron-right" className={styles.cardArrow} />
							</Link>
						</li>
					))}
				</ul>
			</div>
		</ToolLayout>
	);
}
