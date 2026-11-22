import { useToolPath } from "../../src/router.tsx";
import { QuartersPage } from "./quarters.tsx";
import { ThemesPage } from "./themes.tsx";
import { YearPage } from "./year.tsx";

export default function Goals() {
	switch (useToolPath()) {
		case "/quarters":
			return <QuartersPage />;
		case "/themes":
			return <ThemesPage />;
		default:
			return <YearPage />;
	}
}
