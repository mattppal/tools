import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import { MentionsPage } from "./mentions-view.tsx";
import styles from "./x-posts.module.css";

export default function XPosts() {
	return (
		<ToolLayout title="X posts">
			<div className={styles.page}>
				<MentionsPage />
			</div>
		</ToolLayout>
	);
}
