import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A fixed time, so two generated trees carry the same timestamps. */
export const SAMPLE_MTIME = new Date("2026-10-22T10:11:12.345Z");

/** A small tree shaped like an Aras code tree, including files in every runtime directory. */
export const SAMPLE_FILES: Readonly<Record<string, string>> = {
  "Client/scripts/app.js": "console.log('client');\n",
  "Client/styles/site.css": "body { margin: 0; }\n",
  "Server/bin/Aras.Server.Core.dll": "MZ-core-dll-bytes",
  "Server/bin/Aras.Other.dll": "MZ-other-dll-bytes",
  "Server/web.config": "<configuration><appSettings/></configuration>\n",
  "Server/InnovatorServerConfig.xml": "<Innovator><DB-Connection id='x'/></Innovator>\n",
  "OAuthServer/web.config": "<configuration/>\n",
  "OAuthServer/App_Data/readme.xml": "<readme/>\n",
  // Runtime state: not in the manifest, never flagged.
  "Server/temp/cache.tmp": "temp",
  "Server/dll/Method1.dll": "generated",
  "Server/logs/server.log": "log line\n",
  "OAuthServer/App_Data/oauth.sqlite": "sqlite-bytes",
  "OAuthServer/App_Data/oauth.sqlite-wal": "wal-bytes",
  "OAuthServer/App_Data/key-20261022.xml": "<key/>\n",
};

export async function writeSampleFile(root: string, rel: string, content: string, mtime: Date = SAMPLE_MTIME): Promise<void> {
  const file = join(root, ...rel.split("/"));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  await utimes(file, mtime, mtime);
}

export async function makeSampleTree(
  root: string,
  files: Readonly<Record<string, string>> = SAMPLE_FILES,
  mtime: Date = SAMPLE_MTIME,
): Promise<string> {
  for (const [rel, content] of Object.entries(files)) await writeSampleFile(root, rel, content, mtime);
  return root;
}

export async function tempDir(prefix = "arashouse-manifest-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
