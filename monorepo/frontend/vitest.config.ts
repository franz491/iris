import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

const excludedPaths = [
  "**/node_modules/**",
  "**/data/**",
  "**/.venv/**",
  "**/dist/**",
  "**/target/**",
  "**/software/**",
  "**/models/**",
  "**/cache/**",
  "**/external/**",
];

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["tests/**/*.test.ts"],
      exclude: excludedPaths,
    },
  }),
);
