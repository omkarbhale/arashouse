import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODE_SUBPATH,
  checkRelativePath,
  codeRecord,
  deployDigest,
  isProtectedFile,
  parseCodeRecord,
  parseCodeSpec,
  parseDeployManifest,
  planDeploy,
  readDeployManifest,
} from "./code-deploy.js";
import { GuardError } from "./guards.js";

const rules = { subpath: DEFAULT_CODE_SUBPATH };

describe("checkRelativePath", () => {
  it("returns a relative path /-separated", () => {
    expect(checkRelativePath("p", "Client\\scripts\\a.js")).toBe("Client/scripts/a.js");
    expect(checkRelativePath("p", "Server/bin/x.dll")).toBe("Server/bin/x.dll");
  });

  it.each([
    "",
    "/abs",
    "\\abs",
    "C:\\x",
    "a/../b",
    "..",
    "./a",
    "a//b",
    "a/b/",
    "file.txt:stream",
    "a/INNOVA~1.XML",
    "a/con",
    "a/nul.txt",
    "a/b.",
    "a/b ",
    "a\u0001b",
    "a/b?c",
  ])("refuses %j", (path) => {
    expect(() => checkRelativePath("p", path)).toThrow(GuardError);
  });
});

describe("parseCodeSpec", () => {
  it("defaults the subpath to Innovator", () => {
    expect(parseCodeSpec("./build")).toEqual({ source: "./build", subpath: "Innovator" });
    expect(parseCodeSpec("C:\\work\\build.zip")).toEqual({ source: "C:\\work\\build.zip", subpath: "Innovator" });
  });

  it("splits at the last colon that is not a drive's", () => {
    expect(parseCodeSpec("C:\\work\\bin.zip:Innovator/Server/bin")).toEqual({ source: "C:\\work\\bin.zip", subpath: "Innovator/Server/bin" });
    expect(parseCodeSpec("/tmp/out:Innovator\\Client")).toEqual({ source: "/tmp/out", subpath: "Innovator/Client" });
    expect(parseCodeSpec("./cfg:.")).toEqual({ source: "./cfg", subpath: "" });
  });

  it("refuses an empty source or subpath and a subpath that escapes", () => {
    for (const bad of ["", ":Innovator", "./x:", "./x:../y", "./x:/abs"]) expect(() => parseCodeSpec(bad), bad).toThrow(GuardError);
  });
});

describe("isProtectedFile", () => {
  it("matches the secrets and identity files by name, without case", () => {
    for (const p of ["InnovatorServerConfig.xml", "innovator/innovatorserverconfig.XML", "OAuthServer/cert.pfx", "x/y.CER", "OAuthServer/App_Data/key-1.xml", "VaultServer/vault.config"]) {
      expect(isProtectedFile(p), p).toBe(true);
    }
    for (const p of ["Innovator/Client/a.js", "Innovator/Server/bin/x.dll", "Innovator/web.config", "a/keys.xml"]) expect(isProtectedFile(p), p).toBe(false);
  });

  it("matches every file the edit lists render, by its path in the slot's tree (ticket 50)", () => {
    for (const p of ["Innovator/Server/Innovator.xml", "innovator/client/INNOVATOR.xml", "OAuthServer/OAuth.config", "OAuthServer/OAuthServer.config"]) {
      expect(isProtectedFile(p), p).toBe(true);
    }
    for (const p of ["Innovator/Client/Scripts/Innovator.xml", "Innovator/Innovator.xml"]) expect(isProtectedFile(p), p).toBe(false);
  });
});

describe("deploy.json", () => {
  it("takes files and delete, each optional", () => {
    expect(parseDeployManifest({})).toEqual({});
    expect(parseDeployManifest({ files: ["Client\\a.js"], delete: ["Client/old.js"] })).toEqual({ files: ["Client/a.js"], delete: ["Client/old.js"] });
    expect(readDeployManifest(new TextEncoder().encode('\uFEFF{"delete":["x/y"]}'))).toEqual({ delete: ["x/y"] });
  });

  it("refuses another field, a non-list, a bad path and a file that is not JSON", () => {
    expect(() => parseDeployManifest({ mirror: true })).toThrow(/only "files" and "delete"/);
    expect(() => parseDeployManifest({ files: "a" })).toThrow(/not a list/);
    expect(() => parseDeployManifest({ delete: ["../x"] })).toThrow(GuardError);
    expect(() => parseDeployManifest([])).toThrow(GuardError);
    expect(() => readDeployManifest(new TextEncoder().encode("{"))).toThrow(/not JSON/);
  });
});

describe("planDeploy", () => {
  it("overlays every source file under the subpath, deploy.json left out", () => {
    const plan = planDeploy(["Client/a.js", "deploy.json", "Client/b.htm"], rules);
    expect(plan.copies).toEqual([
      { source: "Client/a.js", target: "Innovator/Client/a.js" },
      { source: "Client/b.htm", target: "Innovator/Client/b.htm" },
    ]);
    expect(plan).toMatchObject({ deletes: [], touchesCompiled: false, manifest: false });
  });

  it("copies only the files deploy.json lists, and deletes what it names", () => {
    const plan = planDeploy(["Client/a.js", "Client/b.js"], rules, { files: ["client/A.js"], delete: ["Client/old.js"] });
    expect(plan.copies).toEqual([{ source: "Client/a.js", target: "Innovator/Client/a.js" }]);
    expect(plan.deletes).toEqual(["Innovator/Client/old.js"]);
    expect(plan.manifest).toBe(true);
  });

  it("marks a deploy into Server\\bin or Server\\dll", () => {
    expect(planDeploy(["x.dll"], { subpath: "Innovator/Server/bin" }).touchesCompiled).toBe(true);
    expect(planDeploy(["Server/dll/m.dll"], rules).touchesCompiled).toBe(true);
    expect(planDeploy(["x.dll"], rules, { delete: ["Server/bin/old.dll"] }).touchesCompiled).toBe(true);
  });

  it("writes only Innovator, and VaultServer and OAuthServer with allowServers", () => {
    expect(() => planDeploy(["vault.aspx"], { subpath: "VaultServer" })).toThrow(/--allow-servers/);
    expect(planDeploy(["vault.aspx"], { subpath: "VaultServer", allowServers: true }).copies[0]?.target).toBe("VaultServer/vault.aspx");
    expect(() => planDeploy(["x.exe"], { subpath: "AgentService", allowServers: true })).toThrow(/outside Innovator/);
    expect(() => planDeploy([".arashouse-slot.json"], { subpath: "" })).toThrow(/outside Innovator/);
    expect(() => planDeploy(["Innovator"], { subpath: "" })).toThrow(/the folder Innovator itself/);
  });

  it("needs allowConfig for the secrets and identity files, wherever they are", () => {
    expect(() => planDeploy(["InnovatorServerConfig.xml"], { subpath: "." })).toThrow(/--allow-config/);
    expect(planDeploy(["InnovatorServerConfig.xml"], { subpath: ".", allowConfig: true }).copies[0]?.target).toBe("InnovatorServerConfig.xml");
    expect(() => planDeploy(["App_Data/key-1.xml"], { subpath: "OAuthServer", allowServers: true })).toThrow(/--allow-config/);
    expect(() => planDeploy(["a.js"], rules, { delete: ["Server/x.pfx"] })).toThrow(/--allow-config/);
    // Innovator.xml's ConfigFilePath names the slot's InnovatorServerConfig.xml: replaced, it could name another install's.
    expect(() => planDeploy(["Server/Innovator.xml"], rules)).toThrow(/--allow-config/);
    expect(() => planDeploy(["OAuth.config"], { subpath: "OAuthServer", allowServers: true })).toThrow(/--allow-config/);
    expect(planDeploy(["Server/Innovator.xml"], { ...rules, allowConfig: true }).copies[0]?.target).toBe("Innovator/Server/Innovator.xml");
    // The top-level config is the only file allowConfig adds outside the roots.
    expect(() => planDeploy(["SelfServiceReportConfig.xml"], { subpath: ".", allowConfig: true })).toThrow(/outside Innovator/);
  });

  it("refuses a source with two files that differ only in case, a missing listed file, and a file both copied and deleted", () => {
    expect(() => planDeploy(["Client/A.js", "client/a.js"], rules)).toThrow(/differing only in case/);
    expect(() => planDeploy(["a.js"], rules, { files: ["b.js"] })).toThrow(/does not have/);
    expect(() => planDeploy(["a.js"], rules, { delete: ["A.js"] })).toThrow(/both copies and deletes/);
    expect(() => planDeploy(["a.js"], rules, { files: ["a.js", "A.js"] })).toThrow(/twice/);
  });
});

describe("the lease record's code value", () => {
  const a = deployDigest([{ target: "Innovator/a", sha256: "1".repeat(64) }, { target: "Innovator/b", sha256: "2".repeat(64) }], []);

  it("hashes targets and file hashes in a stable order, no contents", () => {
    expect(deployDigest([{ target: "Innovator/b", sha256: "2".repeat(64) }, { target: "Innovator/a", sha256: "1".repeat(64) }], [])).toBe(a);
    expect(deployDigest([{ target: "Innovator/a", sha256: "1".repeat(64) }], [])).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("counts files and chains the hash over the deploys", () => {
    const first = codeRecord(undefined, 2, a);
    expect(first.text).toBe(`2 files, manifest ${a}`);
    expect(parseCodeRecord(first.text)).toEqual({ files: 2, digest: a });
    const second = codeRecord(parseCodeRecord(first.text), 3, a);
    expect(second.files).toBe(5);
    expect(second.digest).not.toBe(a);
    expect(parseCodeRecord("anything else")).toBeUndefined();
  });
});
