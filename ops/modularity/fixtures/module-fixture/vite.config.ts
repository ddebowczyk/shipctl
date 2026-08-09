import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@shipctl/module-fixture": fileURLToPath(
        new URL("../../../../examples/module-fixture/frontend/src/index.ts", import.meta.url),
      ),
    },
  },
});
