import { useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { useToolPath } from "../../src/router.tsx";
import { ToolLayout, type ToolSection } from "../../src/shell/tool-layout.tsx";
import styles from "./hello.module.css";

const SECTIONS: readonly ToolSection[] = [
	{ label: "Overview", path: "/" },
	{ label: "Database", path: "/database" },
];

type Answer = { text: string; ms: number };

function Details({ answer }: { answer: Answer | null }) {
	return (
		<dl className={styles.details}>
			<dt>Endpoint</dt>
			<dd>
				<code>GET /api/tools/hello/time</code>
			</dd>
			<dt>Round trip</dt>
			<dd>{answer === null ? "Not asked yet" : `${answer.ms} ms`}</dd>
		</dl>
	);
}

export default function Hello() {
	const database = useToolPath() === "/database";
	const [answer, setAnswer] = useState<Answer | null>(null);
	const [loading, setLoading] = useState(false);

	async function askDatabase() {
		setLoading(true);
		const started = performance.now();
		try {
			const response = await fetch("/api/tools/hello/time");
			const body: { now?: string; error?: string } = await response.json();
			setAnswer({ text: body.now ?? body.error ?? "No answer", ms: Math.round(performance.now() - started) });
		} finally {
			setLoading(false);
		}
	}

	return (
		<ToolLayout title="Hello" sections={SECTIONS} panel={database ? { label: "Details", content: <Details answer={answer} /> } : undefined}>
			{database ? (
				<article className={styles.article}>
					<h2 className={styles.heading}>Database</h2>
					<p>Ask Postgres for the time through Hyperdrive.</p>
					<div className={styles.row}>
						<Button onClick={() => void askDatabase()} loading={loading}>
							Ask the database for the time
						</Button>
					</div>
					{answer === null ? null : <p className={styles.answer}>{answer.text}</p>}
				</article>
			) : (
				<article className={styles.article}>
					<h2 className={styles.heading}>Overview</h2>
					<p>A placeholder tool that exercises the shell. Copy it with <code>bun run new-tool &lt;slug&gt;</code> to start a new one.</p>
					<p>Its sections sit under it in the sidebar. The Database section adds a Details panel.</p>
				</article>
			)}
		</ToolLayout>
	);
}
