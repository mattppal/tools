import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import styles from "./goals.module.css";

export default function Goals() {
	return (
		<ToolLayout title="Goals">
			<div className={styles.page}>
				<p>Yearly and quarterly goals by area, with check-ins, for Matt and gtd bot.</p>
			</div>
		</ToolLayout>
	);
}
