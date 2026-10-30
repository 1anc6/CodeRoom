import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API runs on :8000 (see README). Proxying keeps the browser on one origin,
// so no CORS setup is needed in development and the WebSocket shares the same host.
const apiTarget = process.env.CODEROOM_API_URL ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
