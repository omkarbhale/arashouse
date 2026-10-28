import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_INSTALL_ROOT, slotNames, stagingDir, stampFile, type SlotRef } from "../core/names.js";
import { HostError } from "../host/errors.js";
import { Broker, inProcessTransport } from "./broker.js";
import { deployCodeOnHost, parseDeployCodeArgs, registerDeployVerb, stagedCodeFolder, type DeployCodeArgs } from "./code-deploy.js";
import { SlotLocks, provisionSlotOnHost } from "./provision.js";
import { FakeSlotSystem } from "./slot-system.fixture.js";

const ROOT = DEFAULT_INSTALL_ROOT;
const s1: SlotRef = { flavor: "12sp9", slot: 1 };
const names = slotNames(s1, ROOT);
const LEASE = "a".repeat(32);
const OTHER = "b".repeat(32);
const staged = win32.join(stagingDir(LEASE, ROOT), "code", "1");
const inSlot = (rel: string) => win32.join(names.slotDir, ...rel.split("/"));
const inStaged = (rel: string) => win32.join(staged, ...rel.split("/"));

/** A provisioned slot whose stamp names `lease`, as `get` leaves it. */
async function leased(lease: string = LEASE): Promise<FakeSlotSystem> {
  const system = new FakeSlotSystem();
  await provisionSlotOnHost(system, s1, names, ROOT);
  const stamp = JSON.parse(system.text(stampFile(s1, ROOT))!) as Record<string, unknown>;
  system.put(stampFile(s1, ROOT), JSON.stringify({ ...stamp, leaseId: lease }));
  system.calls.length = 0;
  system.warmed.length = 0;
  return system;
}

function args(extra: Partial<DeployCodeArgs> = {}): DeployCodeArgs {
  return { staged, leaseId: LEASE, subpath: "innovator", allowConfig: false, allowServers: false, agent: false, ...extra };
}

async function failure(promise: Promise<unknown>): Promise<HostError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof HostError)) throw new Error(`expected a HostError, got ${String(err)}`);
  return err;
}

/** The calls that change the host, in order. */
function steps(system: FakeSlotSystem): string[] {
  return system.calls.filter((c) => /^(quiesce|start|stop|copyStaged|removeTreeFile|clearCompiled|removeDir)/.test(c));
}

describe("deployCode", () => {
  it("quiesces the leased slot, overlays the staged files, starts and warms it, and removes the staged copy", async () => {
    const system = await leased();
    system.put(inStaged("client/added.js"), "added");
    system.put(inStaged("client/scripts/main.js"), "replaced");
    const result = await deployCodeOnHost(system, s1, names, ROOT, args());
    expect(result).toMatchObject({ ok: true, files: 2, deleted: 0, compiledCleared: false });
    expect(result.detail).toMatch(/^deployed 2 files \(13 bytes\) into 12sp9-01\\innovator in \d+\.\d s; the slot is up: started 12sp9-01/);
    expect(steps(system)).toEqual(["quiesce 12sp9-01", "copyStaged", "copyStaged", "start 12sp9-01", "removeDir"]);
    expect(system.text(inSlot("innovator/client/added.js"))).toBe("added");
    expect(system.text(inSlot("innovator/client/scripts/main.js"))).toBe("replaced");
    // An overlay: the golden files the deploy does not name are still there.
    expect(system.text(inSlot("innovator/server/bin/aras.server.core.dll"))).toBe("dll");
    expect(system.filesUnder(staged)).toEqual([]);
    expect(system.warmed).toHaveLength(3);
  });

  it("applies deploy.json's delete list and copies only its files", async () => {
    const system = await leased();
    system.put(inStaged("deploy.json"), JSON.stringify({ files: ["client/a.js"], delete: ["client/scripts/main.js", "client/gone.js"] }));
    system.put(inStaged("client/a.js"), "a");
    system.put(inStaged("client/b.js"), "b");
    const result = await deployCodeOnHost(system, s1, names, ROOT, args());
    expect(result).toMatchObject({ ok: true, files: 1, deleted: 1 });
    expect(system.text(inSlot("innovator/client/scripts/main.js"))).toBeUndefined();
    expect(system.text(inSlot("innovator/client/a.js"))).toBe("a");
    expect(system.text(inSlot("innovator/client/b.js"))).toBeUndefined();
    expect(system.text(inSlot("innovator/deploy.json"))).toBeUndefined();
  });

  it("clears ASP.NET's temporary files of the alias after a deploy into Server\\bin, and starts the agent again for an agent lease", async () => {
    const system = await leased();
    system.agentInstalled = true;
    system.objects.add(`ASP.NET temporary files ${names.alias}`);
    system.put(inStaged("aras.server.core.dll"), "patched");
    const result = await deployCodeOnHost(system, s1, names, ROOT, args({ subpath: "innovator/server/bin", agent: true }));
    expect(result).toMatchObject({ ok: true, files: 1, compiledCleared: true });
    expect(result.detail).toContain("1 ASP.NET temporary folders of the alias cleared");
    expect(steps(system)).toEqual(["quiesce 12sp9-01", "copyStaged", "clearCompiled 12sp9-01", "start 12sp9-01", "removeDir"]);
    expect(system.text(inSlot("innovator/server/bin/aras.server.core.dll"))).toBe("patched");
    expect(system.agentRunning.has("12sp9-01")).toBe(true);
  });

  it("answers ok: false, the files in place, when the slot does not come back up", async () => {
    const system = await leased();
    system.put(inStaged("client/a.js"), "a");
    system.warmAnswer = (url) => (url.includes("DBList") ? { status: 500, ms: 10 } : { status: 200, ms: 10 });
    const result = await deployCodeOnHost(system, s1, names, ROOT, args());
    expect(result).toMatchObject({ ok: false, files: 1 });
    expect(result.detail).toContain("the slot did not come back up");
    expect(system.text(inSlot("innovator/client/a.js"))).toBe("a");
  });

  describe("refuses, changing nothing", () => {
    const refused = async (system: FakeSlotSystem, a: DeployCodeArgs, message: RegExp | string) => {
      const err = await failure(deployCodeOnHost(system, s1, names, ROOT, a));
      expect(err.kind).toBe("Refused");
      expect(err.message).toMatch(message);
      expect(steps(system).filter((s) => s !== "removeDir")).toEqual([]);
      expect(system.serving.has("12sp9-01")).toBe(true);
    };

    it("a slot its stamp says another lease holds, or no lease", async () => {
      const system = await leased(OTHER);
      system.put(inStaged("client/a.js"), "a");
      await refused(system, args(), "slot 12sp9-01 is not leased by that lease");
      const free = await leased();
      const stamp = JSON.parse(free.text(stampFile(s1, ROOT))!) as Record<string, unknown>;
      free.put(stampFile(s1, ROOT), JSON.stringify({ ...stamp, leaseId: null }));
      free.put(inStaged("client/a.js"), "a");
      await refused(free, args(), "not leased by that lease");
    });

    it("a staged folder that is not staging\\<lease>\\code\\<n>, and is then left alone", async () => {
      const system = await leased();
      for (const path of [stagingDir(LEASE, ROOT), win32.join(stagingDir(OTHER, ROOT), "code", "1"), win32.join(stagingDir(LEASE, ROOT), "code", "x"), names.slotDir, `${staged}\\..\\..\\..`]) {
        system.put(win32.join(path, "client", "a.js"), "a");
        await refused(system, args({ staged: path }), "a staged code tree is");
        expect(system.calls).not.toContain("removeDir");
      }
    });

    it("a staged tree with a link or junction in it, or under it", async () => {
      const system = await leased();
      system.put(inStaged("client/a.js"), "a");
      system.links.add(inStaged("client/link").toLowerCase());
      await refused(system, args(), "links, junctions or other non-files (client/link)");
      const other = await leased();
      other.put(inStaged("client/a.js"), "a");
      other.links.add(win32.join(stagingDir(LEASE, ROOT), "code").toLowerCase());
      await refused(other, args(), "not a plain folder (link)");
    });

    it("InnovatorServerConfig.xml without --allow-config, a path outside Innovator without --allow-servers, a .. in deploy.json", async () => {
      const cases: [Partial<DeployCodeArgs>, Record<string, string>, RegExp][] = [
        [{ subpath: "" }, { "innovatorserverconfig.xml": "<x/>" }, /--allow-config/],
        [{ subpath: "vaultserver" }, { "vault.aspx": "x" }, /--allow-servers/],
        [{}, { "deploy.json": JSON.stringify({ delete: ["../innovatorserverconfig.xml"] }) }, /segment/],
        [{}, { "deploy.json": "{" }, /not JSON/],
        [{}, {}, /is missing|deploys nothing/],
      ];
      for (const [extra, files, message] of cases) {
        const system = await leased();
        system.objects.add(staged);
        for (const [rel, text] of Object.entries(files)) system.put(inStaged(rel), text);
        await refused(system, args(extra), message);
      }
    });

    it("a target whose folder in the slot's tree is a junction, or is a file, or a target that is a folder", async () => {
      const cases: [(s: FakeSlotSystem) => void, RegExp][] = [
        [(s) => s.links.add(inSlot("innovator/client").toLowerCase()), /innovator\\client is a link, not a plain folder/],
        [(s) => s.put(inSlot("innovator/client/x"), "file"), /is a file/],
        [(s) => s.put(inSlot("innovator/client/x/a.js/inner.txt"), "folder"), /it is a folder, not a file/],
      ];
      for (const [arrange, message] of cases) {
        const system = await leased();
        system.put(inStaged("client/x/a.js"), "a");
        arrange(system);
        await refused(system, args(), message);
      }
    });
  });

  it("starts the slot again when the copy fails after the quiesce, and answers the failure", async () => {
    const system = await leased();
    system.put(inStaged("client/a.js"), "a");
    system.failNext("copyStaged", new Error("disk full"));
    const err = await failure(deployCodeOnHost(system, s1, names, ROOT, args()));
    expect(err).toMatchObject({ kind: "Retryable", message: expect.stringMatching(/^deploy into 12sp9-01 failed at copy: disk full; the slot was started again$/) });
    expect(steps(system)).toEqual(["quiesce 12sp9-01", "copyStaged", "start 12sp9-01", "removeDir"]);
    expect(system.serving.has("12sp9-01")).toBe(true);
  });

  it("checks its arguments: six, each of its type, the subpath relative", () => {
    expect(parseDeployCodeArgs({ staged, leaseId: LEASE })).toEqual(args({ subpath: "Innovator" }));
    expect(parseDeployCodeArgs({ staged, leaseId: LEASE, subpath: ".", allowConfig: true })).toMatchObject({ subpath: "", allowConfig: true });
    for (const bad of [{ staged, leaseId: "x" }, { staged, leaseId: LEASE, path: "C:\\x" }, { staged, leaseId: LEASE, subpath: "../x" }, { staged, leaseId: LEASE, agent: "yes" }, { leaseId: LEASE }]) {
      expect(() => parseDeployCodeArgs(bad), JSON.stringify(bad)).toThrow();
    }
    expect(stagedCodeFolder(ROOT, LEASE, staged.toUpperCase().replace("C:", "c:"))).toBe(win32.join(stagingDir(LEASE, ROOT), "code", "1"));
  });

  it("is registered on the broker under the slot locks, refusing a bad argument as Refused", async () => {
    const system = await leased();
    system.put(inStaged("client/a.js"), "a");
    const broker = registerDeployVerb(new Broker({ root: ROOT }), system, new SlotLocks());
    const transport = inProcessTransport(broker);
    const ok = (await transport.call({ id: "r1", verb: "deployCode", slot: s1, args: { staged, leaseId: LEASE } })) as { ok: boolean; result: Record<string, unknown> };
    expect(ok).toMatchObject({ ok: true, result: { ok: true, files: 1, deleted: 0, compiledCleared: false } });
    const bad = (await transport.call({ id: "r2", verb: "deployCode", slot: s1, args: { staged, leaseId: LEASE, command: "rm" } })) as { ok: boolean; error: Record<string, unknown> };
    expect(bad).toMatchObject({ ok: false, error: { kind: "Refused" } });
  });
});
