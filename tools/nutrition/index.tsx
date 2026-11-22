import { useToolPath } from "../../src/router.tsx";
import { History } from "./history.tsx";
import { PhaseView } from "./phase-view.tsx";
import { Today } from "./today.tsx";
import { Weight } from "./weight.tsx";

export default function Nutrition() {
	switch (useToolPath()) {
		case "/history":
			return <History />;
		case "/weight":
			return <Weight />;
		case "/phase":
			return <PhaseView />;
		default:
			return <Today />;
	}
}
