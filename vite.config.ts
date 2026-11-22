import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { serviceWorker } from "./scripts/sw-vite.ts";
import { xeet } from "./scripts/xeet-vite.ts";

export default defineConfig({
	server: { host: "127.0.0.1", port: 5173 },
	plugins: [tailwindcss(), react(), cloudflare(), serviceWorker(), xeet()],
});
