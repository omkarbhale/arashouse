import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // NTFS, its flushes and the antivirus scanner make each state update slower on Windows; the lock-heavy tests
    // run many in a row, and a whole parallel run there needs more than the 5 s default.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
  },
});
