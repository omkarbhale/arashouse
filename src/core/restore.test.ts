import { describe, expect, it } from "vitest";
import { DENIED_DATABASES } from "./guards.js";
import {
  PROFILE_NAME,
  backupProblems,
  compareVersions,
  flavorOfVersion,
  stagedBackup,
  wrongFlavorHint,
  type BackupHeader,
  type RestoreTarget,
} from "./restore.js";

const header: BackupHeader = {
  sets: [{ position: 1, backupType: 1, databaseName: "scratch_12sp9", softwareVersion: "11.0.7001" }],
  files: [
    { logicalName: "scratch", type: "D", sizeBytes: 80 * 1024 ** 2 },
    { logicalName: "scratch_log", type: "L", sizeBytes: 1024 ** 2 },
  ],
};
const target: RestoreTarget = { serverVersion: "15.0.2190.7", freeBytes: 50 * 1024 ** 3 };

describe("backupProblems", () => {
  it("passes one full backup of one data and one log file, from an older or the same SQL Server, that fits", () => {
    expect(backupProblems(header, target)).toEqual([]);
    expect(backupProblems({ ...header, sets: [{ ...header.sets[0]!, softwareVersion: "15.0.2190" }] }, target)).toEqual([]);
  });

  it("refuses a backup from a newer SQL Server: it cannot be restored on an older one", () => {
    expect(backupProblems({ ...header, sets: [{ ...header.sets[0]!, softwareVersion: "16.0.1000" }] }, target)).toEqual([
      "the backup was written by SQL Server 16.0.1000, newer than this host's 15.0.2190.7: a backup cannot be restored on an older SQL Server",
    ]);
  });

  it("refuses a backup taken of a deny-listed database unless a foreign origin is allowed (map question Q6)", () => {
    for (const name of [...DENIED_DATABASES, "olm_copy", "PROD", "my_prod_2"]) {
      const named = { ...header, sets: [{ ...header.sets[0]!, databaseName: name }] };
      const problems = backupProblems(named, target);
      expect(problems, name).toHaveLength(1);
      expect(problems[0], name).toContain(`taken of the database "${name}", which is deny-listed`);
      expect(problems[0], name).toContain("pass --allow-foreign-origin");
      expect(backupProblems(named, target, { allowForeignOrigin: true }), name).toEqual([]);
    }
    // The CD's own backups record names of their own, which are not on the deny-list.
    const cd = { ...header, sets: [{ ...header.sets[0]!, databaseName: "Solutions.S12-0-SP9.12.0.24090.ConvertSqlToBackup" }] };
    expect(backupProblems(cd, target)).toEqual([]);
  });

  it("refuses more than one backup set, a backup that is not a full one, and a database of other than two files", () => {
    expect(backupProblems({ ...header, sets: [header.sets[0]!, { ...header.sets[0]!, position: 2 }] }, target)).toEqual([
      "the file holds 2 backup sets; arashouse restores a file with one full database backup",
    ]);
    expect(backupProblems({ ...header, sets: [] }, target)[0]).toContain("holds 0 backup sets");
    expect(backupProblems({ ...header, sets: [{ ...header.sets[0]!, backupType: 5 }] }, target)).toEqual(["the backup is not a full database backup (type 5)"]);
    const three = { ...header, files: [...header.files, { logicalName: "ft", type: "F", sizeBytes: 1 }] };
    expect(backupProblems(three, target)).toEqual(["the backed-up database has 3 files (D, L, F); arashouse restores a database of one data file and one log file"]);
    const twoData = { ...header, files: [header.files[0]!, { ...header.files[0]!, logicalName: "second" }] };
    expect(backupProblems(twoData, target)[0]).toContain("has 2 files (D, D)");
  });

  it("refuses a database that does not fit in the free space", () => {
    expect(backupProblems(header, { ...target, freeBytes: 10 * 1024 ** 2 })).toEqual(["the restored database needs 0.1 GB and the drive of sqldata\\ has 0.0 GB free"]);
  });

  it("names every problem at once", () => {
    const bad = { sets: [{ position: 1, backupType: 2, databaseName: "OLM_Local", softwareVersion: "17.0.1" }], files: [] };
    expect(backupProblems(bad, target)).toHaveLength(4);
  });
});

describe("compareVersions", () => {
  it("compares number by number", () => {
    expect(compareVersions("11.0.7001", "15.0.2190.7")).toBe(-1);
    expect(compareVersions("15.0.2190", "15.0.2190.0")).toBe(0);
    expect(compareVersions("15.0.4000", "15.0.2190.7")).toBe(1);
    expect(compareVersions("9.0", "10.0")).toBe(-1);
  });
});

describe("the flavor of a restored database", () => {
  it("is the flavor whose server build its version rows name", () => {
    expect(flavorOfVersion({ VersionMajor: "12", VersionBuild: "24090" })).toBe("12sp9");
    expect(flavorOfVersion({ VersionMajor: "14", VersionBuild: "36073" })).toBe("23");
    expect(flavorOfVersion({ VersionMajor: "14", VersionBuild: "43890" })).toBe("35");
    expect(flavorOfVersion({ VersionMajor: "14", VersionBuild: "39055" })).toBeUndefined();
  });

  it("gives the --flavor hint, or says no flavor has the build", () => {
    expect(wrongFlavorHint({ VersionMajor: "14", VersionBuild: "36073" })).toBe(
      "it is a 23 database: restore it into a 23 lease (arashouse get 23 --restore ...), or pass --skip-version-check to keep it",
    );
    expect(wrongFlavorHint({ VersionMajor: "11", VersionBuild: "6549" })).toBe("no flavor has that build, or pass --skip-version-check to keep it");
  });
});

describe("the staged backup", () => {
  it("is restore.bak in the lease's staging folder", () => {
    expect(stagedBackup("0123456789abcdef0123456789abcdef")).toBe("C:\\aras_installations\\staging\\0123456789abcdef0123456789abcdef\\restore.bak");
    expect(stagedBackup("0123456789abcdef0123456789abcdef", "D:\\pool")).toBe("D:\\pool\\staging\\0123456789abcdef0123456789abcdef\\restore.bak");
  });

  it("is named from a profile only by a plain file name", () => {
    for (const ok of ["demo", "Partner-Demo_35", "v1.2"]) expect(PROFILE_NAME.test(ok), ok).toBe(true);
    for (const bad of ["", ".hidden", "../x", "a/b", "a\\b", "x".repeat(65), "with space"]) expect(PROFILE_NAME.test(bad), bad).toBe(false);
  });
});
