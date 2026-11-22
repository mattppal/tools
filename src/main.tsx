import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./shell/shell.tsx";
import "./styles/global.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root");

createRoot(root).render(
	<StrictMode>
		<Shell />
	</StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
	window.addEventListener("load", () => {
		void navigator.serviceWorker.register("/sw.js");
	});
}
