import { defineConfig } from "vitest/config";

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

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "src/net/pinned-http.ts",
        "src/api/auth.ts",
        "src/api/binary-limits.ts",
        "src/api/files.ts",
        "src/model-router/openai-compat.ts",
      ],
      thresholds: { perFile: true, lines: 70, functions: 60, branches: 55, statements: 70 },
    },
    include: ["tests/**/*.test.ts"],
    exclude: excludedPaths,
    setupFiles: ["tests/setup.ts"],
    fileParallelism: false,
  },
});
