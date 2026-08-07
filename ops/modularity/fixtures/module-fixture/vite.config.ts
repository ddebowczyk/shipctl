import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@shep/module-fixture": fileURLToPath(
        new URL("../../../../modules/fixture/frontend/src/index.ts", import.meta.url),
      ),
    },
  },
});
