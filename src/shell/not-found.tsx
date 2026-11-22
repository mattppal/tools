import { Link } from "../router.tsx";
import { ToolLayout } from "./tool-layout.tsx";

export function NotFound() {
	return (
		<ToolLayout title="Not found">
			<p>
				There is no tool here. <Link href="/">Back to all tools</Link>
			</p>
		</ToolLayout>
	);
}
