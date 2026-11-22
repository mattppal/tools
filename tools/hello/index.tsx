import { useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../../src/kit/sidebar.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import styles from "./hello.module.css";

const SECTIONS = [
	{ id: "overview", label: "Overview", body: "This is a placeholder tool. Copy it with `bun run new-tool <slug>` to start a new one." },
	{ id: "sidebar", label: "Secondary sidebar", body: "Pass `sidebar` to ToolLayout to get a second column beside the main navigation. On phones it opens as a drawer." },
	{ id: "panel", label: "Right panel", body: "Pass `panel` to ToolLayout for a right-hand panel. It docks on wide screens and becomes a sheet on smaller ones." },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export default function Hello() {
	const [section, setSection] = useState<SectionId>("overview");
	const [panelOpen, setPanelOpen] = useState(false);
	const [time, setTime] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const current = SECTIONS.find((candidate) => candidate.id === section) ?? SECTIONS[0];

	async function askDatabase() {
		setLoading(true);
		try {
			const response = await fetch("/api/tools/hello/time");
			const body: { now?: string; error?: string } = await response.json();
			setTime(body.now ?? body.error ?? "No answer");
		} finally {
			setLoading(false);
		}
	}

	return (
		<ToolLayout
			title="Hello"
			sidebar={{
				label: "Sections",
				content: (close) => (
					<SidebarMenu>
						{SECTIONS.map((item) => (
							<SidebarMenuItem key={item.id}>
								<SidebarMenuButton
									isActive={item.id === section}
									onClick={() => {
										setSection(item.id);
										close();
									}}
								>
									<span>{item.label}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				),
			}}
			panel={{
				label: "Details",
				open: panelOpen,
				onOpenChange: setPanelOpen,
				content: (
					<div className={styles.details}>
						<p>The right panel is for context about the current selection.</p>
						<p>
							Current section: <strong>{current.label}</strong>
						</p>
					</div>
				),
			}}
		>
			<article className={styles.article}>
				<h2 className={styles.heading}>{current.label}</h2>
				<p>{current.body}</p>
				<div className={styles.row}>
					<Button onClick={() => void askDatabase()} loading={loading}>
						Ask the database for the time
					</Button>
					<Button variant="quiet" onClick={() => setPanelOpen(!panelOpen)}>
						{panelOpen ? "Hide details" : "Show details"}
					</Button>
				</div>
				{time === null ? null : <p className={styles.answer}>{time}</p>}
			</article>
		</ToolLayout>
	);
}
