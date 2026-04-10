import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const PORT = parseInt(process.env.VITE_PORT || "8081", 10);

export default defineConfig({
  root: "src/ui",
  base: "./",
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src/ui") },
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: PORT,
    strictPort: true,
  },
});
