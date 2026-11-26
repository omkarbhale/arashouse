import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GuardError } from "../core/guards.js";
import { parseCodeRecord } from "../core/code-deploy.js";
import { StateStore } from "../core/store.js";
import { buildZip } from "../core/zip.fixture.js";
import { FakeHost, fakeGoldenHash } from "../host/fake.js";
import { deployCodeOnLease, localSourcePath, planSource, refusedDeploy, type CodeTarget } from "./code.js";

const rules = { allowConfig: false, allowServers: false };
let dir: string;
let src: string;
let localRoot: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arashouse-code-"));
  src = join(dir, "src");
  localRoot = join(dir, "root");
  await mkdir(join(src, "Client", "scripts"), { recursive: true });
  await writeFile(join(src, "Client", "scripts", "fix.js"), "fixed");
  await mkdir(localRoot);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function refused(promise: Promise<unknown>, message: RegExp): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GuardError);
  expect((err as Error).message).toMatch(message);
}

describe("planSource", () => {
  it("plans a folder under Innovator, and a Windows path as this process opens it", async () => {
    const planned = await planSource(src, rules);
    expect(planned.kind).toBe("dir");
    expect(planned.plan.copies).toEqual([{ source: "Client/scripts/fix.js", target: "Innovator/Client/scripts/fix.js" }]);
    expect(localSourcePath("C:\\work\\out")).toBe(process.platform === "win32" ? "C:\\work\\out" : "/mnt/c/work/out");
    expect(localSourcePath("rel", join(dir, "base"))).toBe(join(dir, "base", "rel"));
  });

  it("plans a zip, with its deploy.json, at the subpath given", async () => {
    const zip = join(dir, "bin.zip");
    await writeFile(zip, buildZip([{ name: "Lease.dll", data: "dll" }, { name: "dir/", data: "" }, { name: "deploy.json", data: JSON.stringify({ delete: ["Old.dll"] }) }]));
    const planned = await planSource(`${zip}:Innovator/Server/bin`, rules);
    expect(planned.kind).toBe("zip");
    expect(planned.plan).toMatchObject({
      copies: [{ source: "Lease.dll", target: "Innovator/Server/bin/Lease.dll" }],
      deletes: ["Innovator/Server/bin/Old.dll"],
      touchesCompiled: true,
      manifest: true,
    });
  });

  it("refuses a symbolic link, a zip entry with .., a damaged zip, a file that is not a zip, a missing source and a protected file", async () => {
    await symlink(join(dir, "elsewhere"), join(src, "Client", "link"));
    await refused(planSource(src, rules), /symbolic link or junction/);
    const evil = join(dir, "evil.zip");
    await writeFile(evil, buildZip([{ name: "../InnovatorServerConfig.xml", data: "x" }]));
    await refused(planSource(evil, rules), /segment/);
    const damaged = join(dir, "damaged.zip");
    await writeFile(damaged, buildZip([{ name: "a.js", data: "a" }], { centralDirectory: false }));
    await refused(planSource(damaged, rules), /damaged/);
    await writeFile(join(dir, "a.txt"), "x");
    await refused(planSource(join(dir, "a.txt"), rules), /a folder or a \.zip/);
    await refused(planSource(join(dir, "none"), rules), /does not exist/);
    const cfg = join(dir, "cfg");
    await mkdir(cfg);
    await writeFile(join(cfg, "InnovatorServerConfig.xml"), "<x/>");
    await refused(planSource(`${cfg}:.`, rules), /--allow-config/);
    expect((await planSource(`${cfg}:.`, { allowConfig: true, allowServers: false })).plan.copies[0]?.target).toBe("InnovatorServerConfig.xml");
  });
});

describe("deployCodeOnLease", () => {
  const slot = { flavor: "12sp9", slot: 1 } as const;

  async function leased(): Promise<{ store: StateStore; host: FakeHost; target: CodeTarget }> {
    const store = new StateStore({ home: join(dir, "home") });
    const host = new FakeHost();
    await host.provisionSlot(slot);
    const lease = await store.update((tx) => {
      const s = tx.addSlot(slot);
      tx.transition(s.id, { to: "free", golden_hash: fakeGoldenHash("12sp9"), reset_ms: 1 });
      return tx.transition(s.id, { to: "leased", holder: "t" }).lease!;
    });
    const { stamp } = await host.readStamp(slot);
    await host.writeStamp(slot, { ...stamp!, leaseId: lease.lease_id });
    return { store, host, target: { slot: "12sp9-01", leaseId: lease.lease_id, agent: false } };
  }

  it("stages each source, deploys it, records files and hash on the lease, and removes the staged copy", async () => {
    const { store, host, target } = await leased();
    const zip = join(dir, "b.zip");
    await writeFile(zip, buildZip([{ name: "x.dll", data: "x" }]));
    const report = await deployCodeOnLease({ store, host, localRoot }, target, [await planSource(src, rules), await planSource(`${zip}:Innovator/Server/bin`, rules)], rules);
    expect(report.ok).toBe(true);
    expect(report.outcomes.map((o) => [o.subpath, o.ok])).toEqual([
      ["Innovator", true],
      ["Innovator/Server/bin", true],
    ]);
    const deploys = host.calls.filter((c) => c.method === "deployCode");
    expect(deploys.map((c) => c.args.path)).toEqual([`C:\\aras_installations\\staging\\${target.leaseId}\\code\\1`, `C:\\aras_installations\\staging\\${target.leaseId}\\code\\1`]);
    const bootstrap = (await store.read()).slots["12sp9-01"]?.lease?.bootstrap;
    expect(bootstrap?.code_deploys).toBe(2);
    expect(parseCodeRecord(bootstrap?.code)).toMatchObject({ files: 0 });
    expect(await readdir(localRoot)).toEqual(["staging"]);
    expect(await readdir(join(localRoot, "staging"))).toEqual([]);
  });

  it("stops at the first deploy that fails, says why, and still removes the staged copy", async () => {
    const { store, host, target } = await leased();
    host.injectFault({ method: "deployCode", kind: "fail", error: "Refused", message: "the deploy would write a path outside Innovator" });
    const report = await deployCodeOnLease({ store, host, localRoot }, target, [await planSource(src, rules), await planSource(src, rules)], rules);
    expect(report.ok).toBe(false);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]).toMatchObject({ ok: false, files: 0, detail: "the deploy would write a path outside Innovator" });
    expect(refusedDeploy(report)).toBe(true);
    expect((await store.read()).slots["12sp9-01"]?.lease?.bootstrap).toBeUndefined();
    expect(await readdir(join(localRoot, "staging"))).toEqual([]);
  });
});
