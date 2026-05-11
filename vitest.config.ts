// Vitest config: scope test discovery to this project's tests/ directory.
// Without this, vitest's default glob picks up tests from sibling projects
// (e.g. an adjacent goldmanportal/ folder) when this repo lives inside a
// larger workspace.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
