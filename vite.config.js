import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { config as dotenvConfig } from "dotenv";

dotenvConfig(); // load .env into process.env before reading VITE_PORT

const PORT = parseInt(process.env.VITE_PORT || "5173", 10);

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
