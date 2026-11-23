import { useState, type KeyboardEvent } from "react";
import { Input } from "../kit/input.tsx";
import { TOOLS, type Tool } from "../registry.ts";
import { Link, navigate } from "../router.tsx";
import { useHealth, type Health } from "./health.ts";
import { Emoji } from "./emoji.tsx";
import styles from "./home.module.css";
import { Icon } from "./icons.tsx";
import { ToolLayout } from "./tool-layout.tsx";

const FILTER_FROM = 7;

function healthText(health: Health): string {
	switch (health.state) {
		case "checking":
			return "Checking database";
		case "ok":
			return `Database connected · ${health.latencyMs} ms`;
		case "down":
			return "Database unreachable";
		default: {
			const never: never = health;
			return never;
		}
	}
}

function DbStatus() {
	const health = useHealth();
	return (
		<span className={styles.status} data-state={health.state} role="status">
			{healthText(health)}
		</span>
	);
}

function countText(count: number): string {
	return count === 1 ? "1 tool" : `${count} tools`;
}

function matches(tool: Tool, query: string): boolean {
	return `${tool.name} ${tool.description} ${tool.slug}`.toLowerCase().includes(query);
}

function ToolCard({ tool }: { tool: Tool }) {
	return (
		<Link href={`/${tool.slug}`} className={styles.card}>
			<span className={styles.cardIcon}>
				<Emoji emoji={tool.emoji} size={24} />
			</span>
			<span className={styles.cardText}>
				<span className={styles.cardName}>{tool.name}</span>
				<span className={styles.cardDescription}>{tool.description}</span>
			</span>
			<Icon name="chevron-right" className={styles.cardArrow} />
		</Link>
	);
}

function Filter({ query, onQueryChange, only }: { query: string; onQueryChange: (query: string) => void; only: Tool | undefined }) {
	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "Enter" && only !== undefined) navigate(`/${only.slug}`);
		if (event.key === "Escape" && query !== "") {
			event.preventDefault();
			onQueryChange("");
		}
	}
	return (
		<label className={styles.filter}>
			<Icon name="search" className={styles.filterIcon} />
			<Input
				type="search"
				value={query}
				onValueChange={onQueryChange}
				onKeyDown={onKeyDown}
				placeholder="Filter tools"
				aria-label="Filter tools"
				autoComplete="off"
				enterKeyHint="go"
				className={styles.filterInput}
			/>
		</label>
	);
}

function Empty({ title, children }: { title: string; children: string }) {
	return (
		<div className={styles.empty}>
			<p className={styles.emptyTitle}>{title}</p>
			<p className={styles.emptyText}>{children}</p>
		</div>
	);
}

function ToolList({ tools, query }: { tools: readonly Tool[]; query: string }) {
	if (TOOLS.length === 0) return <Empty title="No tools yet">Tools added under tools/ show up here.</Empty>;
	if (tools.length === 0) return <Empty title="No matches">{`Nothing matches “${query}”.`}</Empty>;
	return (
		<ul className={styles.grid} aria-label="Tools">
			{tools.map((tool) => (
				<li key={tool.slug} className={styles.item}>
					<ToolCard tool={tool} />
				</li>
			))}
		</ul>
	);
}

export function Home() {
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const visible = needle === "" ? TOOLS : TOOLS.filter((tool) => matches(tool, needle));
	return (
		<ToolLayout title="Home">
			<div className={styles.page}>
				<section className={styles.intro}>
					<h2 className={styles.heading}>Tools</h2>
					<p className={styles.meta}>
						<span className={styles.count}>{countText(TOOLS.length)}</span>
						<DbStatus />
					</p>
				</section>
				{TOOLS.length >= FILTER_FROM ? <Filter query={query} onQueryChange={setQuery} only={visible.length === 1 ? visible[0] : undefined} /> : null}
				<ToolList tools={visible} query={query.trim()} />
			</div>
		</ToolLayout>
	);
}
