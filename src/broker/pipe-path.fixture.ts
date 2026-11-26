// A path a test's pipe server listens on: a Unix socket in the test's folder on Linux, a named pipe of its own
// (`\\.\pipe\arashouse-test-<pid>-<random>-<name>`) on Windows, where a server cannot listen on a file path.

import { randomBytes } from "node:crypto";
import { join } from "node:path";

export function testPipePath(dir: string, name: string): string {
  if (process.platform !== "win32") return join(dir, name);
  return `\\\\.\\pipe\\arashouse-test-${process.pid}-${randomBytes(4).toString("hex")}-${name}`;
}
