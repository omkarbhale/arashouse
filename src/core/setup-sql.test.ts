import { describe, expect, it } from "vitest";
import { FLAVOR_KEYS } from "./flavors.js";
import { DENIED_DATABASES, assertOwned } from "./guards.js";
import { MAX_SLOT, databaseFiles, databaseName, loginName } from "./names.js";
import {
  ADMIN_PROCEDURES,
  NEGATIVE_DATABASE,
  POOL_LOGIN,
  SELF_TEST_SLOT,
  ADOPTER_PERMISSIONS,
  SIGNERS,
  SIGNER_PERMISSIONS,
  SQL_ERRORS,
  checkSqlLogin,
  databasePatterns,
  likeAny,
  loginPatterns,
  negativeDatabaseNames,
  negativeLoginNames,
  negativeStagedFiles,
  renderAdminProcedures,
  renderSetupSqlScript,
  stagedBackupPattern,
} from "./setup-sql.js";
import { stagedBackup } from "./restore.js";

const procedures = renderAdminProcedures();
const script = renderSetupSqlScript({ version: "0.0.0" });

/**
 * The procedures' allowlist as T-SQL evaluates it: `LIKE` in a binary collation, where `[_]` is a
 * literal underscore, `[0-9]` an ASCII digit and `%` anything; no trailing space; not slot 00.
 */
function allowed(name: string, patterns: readonly string[], zeroSlot: string): boolean {
  const toRegExp = (like: string) =>
    new RegExp(`^${like.replace(/\[_\]/g, "_").replace(/\[0-9\]/g, "[0-9]").replace(/%/g, ".*").replace(/___$/, "...")}$`);
  if (name.length !== name.trimEnd().length) return false;
  return patterns.some((p) => toRegExp(p).test(name)) && !toRegExp(zeroSlot).test(name);
}
const dbAllowed = (name: string) => allowed(name, databasePatterns(), "%[_]00");
const loginAllowed = (name: string) => allowed(name, loginPatterns(), "%[_]00[_]___");

/** The text between the first and last line of a procedure, without its `--` comments. */
function body(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}

/** Each `DECLARE <v> <type> = <expr>;` or `SET <v> = <expr>;` in `code`: the expression up to the first `;` outside a string. */
function assignments(code: string, variable: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(new RegExp(`(?:DECLARE ${variable} [a-z]+\\(\\w+\\)|SET ${variable}) = `, "g"))) {
    let i = (m.index as number) + m[0].length;
    let inString = false;
    const start = i;
    for (; i < code.length; i++) {
      if (code[i] === "'") inString = !inString;
      else if (code[i] === ";" && !inString) break;
    }
    out.push(code.slice(start, i));
  }
  return out;
}

/** The operands of a T-SQL `+` expression that are not string literals. */
function nonLiteralOperands(expression: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  let inString = false;
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i] as string;
    if (inString) {
      current += c;
      if (c === "'" && expression[i + 1] === "'") {
        current += "'";
        i++;
      } else if (c === "'") inString = false;
      continue;
    }
    if (c === "'") inString = true;
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "+" && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  out.push(current.trim());
  return out.filter((o) => !/^N?'.*'$/s.test(o));
}

describe("the arashouse_admin procedures", () => {
  it("are the seven the tickets name, each a dbo procedure in its own CREATE PROCEDURE", () => {
    expect(Object.keys(procedures)).toEqual([...ADMIN_PROCEDURES]);
    for (const [name, text] of Object.entries(procedures)) {
      expect(text.startsWith(`CREATE PROCEDURE dbo.${name} `)).toBe(true);
      expect(text.trimEnd().endsWith("END")).toBe(true);
      expect(text).toMatch(/^[\x00-\x7f]*$/);
      expect(text.split("\n").some((l) => l.startsWith("'@"))).toBe(false);
    }
  });

  it("check the name against the allowlist before anything else", () => {
    for (const [name, text] of Object.entries(procedures)) {
      const code = body(text);
      const refuse = code.indexOf(`THROW ${SQL_ERRORS.refusedName},`);
      expect(refuse, name).toBeGreaterThan(0);
      const variable = name.endsWith("_login") ? "@login" : name === "read_staged_backup" ? "@file" : "@database";
      expect(code.indexOf(`IF ${variable} IS NULL`), name).toBeLessThan(refuse);
      // Nothing reads the catalog, builds SQL or runs it before the refusal.
      for (const later of ["sys.", "DB_ID(", "SUSER_SID(", "EXEC", "DECLARE", "SET @", "RESTORE"]) {
        const at = code.indexOf(later);
        expect(at === -1 || at > refuse, `${name}: ${later} before the allowlist`).toBe(true);
      }
      expect(code).toContain(`${variable} COLLATE Latin1_General_BIN2 LIKE`);
      expect(code).toContain(`DATALENGTH(${variable}) <> 2 * LEN(${variable})`);
    }
  });

  it("build dynamic SQL only from a checked name through QUOTENAME, a path under sqldata, a session id or the escaped password", () => {
    const allowedOperands = new Set([
      "QUOTENAME(@database)",
      "QUOTENAME(@login)",
      "QUOTENAME(@database + N'_data')",
      "QUOTENAME(@database + N'_log')",
      `QUOTENAME(N'${POOL_LOGIN}')`,
      "@data",
      "@log",
      "@secret",
      "CAST(@spid AS nvarchar(11))",
      "REPLACE(@password, N'''', N'''''')",
    ]);
    let executed = 0;
    for (const [name, text] of Object.entries(procedures)) {
      const code = body(text);
      for (const m of code.matchAll(/EXEC \((@\w+)\);/g)) {
        executed++;
        const variable = m[1] as string;
        // Every assignment of the executed variable, and of the variables it is built from.
        for (const v of [variable, "@data", "@log", "@secret"]) {
          for (const a of assignments(code, v)) {
            for (const operand of nonLiteralOperands(a)) {
              if ((v === "@data" || v === "@log") && operand === "@database") continue; // under the fixed sqldata prefix
              expect(allowedOperands.has(operand), `${name}: ${v} is built from ${operand}`).toBe(true);
            }
          }
        }
      }
      expect(code).not.toMatch(/sp_executesql|EXECUTE\s*\(|OPENROWSET|xp_/i);
    }
    expect(executed).toBeGreaterThanOrEqual(8);
  });

  it("put a slot database's files where databaseFiles() says, under sqldata", () => {
    const create = procedures.create_slot_database;
    const files = databaseFiles(databaseName(SELF_TEST_SLOT));
    expect(files.data).toBe("C:\\aras_installations\\sqldata\\arashouse_35_99.mdf");
    expect(create).toContain("DECLARE @data nvarchar(260) = N'C:\\aras_installations\\sqldata\\' + @database + N'.mdf';");
    expect(create).toContain("DECLARE @log nvarchar(260) = N'C:\\aras_installations\\sqldata\\' + @database + N'_log.ldf';");
    expect(create).toContain("SET AUTO_CLOSE OFF");
    expect(renderAdminProcedures("D:\\pool").create_slot_database).toContain("N'D:\\pool\\sqldata\\'");
  });

  it("act only on a database the pool login owns, and only on a plain SQL login outside every role", () => {
    for (const name of ["drop_slot_database", "kill_connections"] as const) {
      expect(procedures[name]).toContain("owner_sid = @pool");
      expect(procedures[name]).toContain(`THROW ${SQL_ERRORS.notOwned},`);
    }
    expect(procedures.create_slot_database).toContain(`THROW ${SQL_ERRORS.notOwned},`);
    for (const name of ["create_slot_login", "drop_slot_login"] as const) {
      expect(procedures[name]).toContain("type <> 'S'");
      expect(procedures[name]).toContain("sys.server_role_members");
    }
    expect(procedures.create_slot_login).toContain("CHECK_POLICY = OFF, CHECK_EXPIRATION = OFF");
    expect(procedures.create_slot_login).toContain("LEN(@password) < 16");
    // A session is ended only in the slot database (or of the slot login), never the caller's own.
    for (const name of ["drop_slot_database", "kill_connections", "drop_slot_login"] as const) {
      expect(procedures[name]).toContain("s.session_id <> @@SPID");
      expect(procedures[name]).toContain("s.is_user_process = 1");
    }
  });

  it("carry no credential, no sa and nothing of the captain's", () => {
    for (const text of Object.values(procedures)) {
      expect(text).not.toMatch(/\bsa\b|PASSWORD\s*=\s*N?'[^'\s]/i);
      expect(text).not.toMatch(/olm|prod|InnovatorSolutions|RabbitDemo|Program Files/i);
      for (const denied of DENIED_DATABASES) expect(text.toLowerCase()).not.toContain(`'${denied.toLowerCase()}'`);
    }
  });
});

describe("the allowlist inside the procedures", () => {
  it("is one pattern per flavor (and role), derived from names.ts", () => {
    expect(databasePatterns()).toEqual(FLAVOR_KEYS.map((k) => `arashouse[_]${k}[_][0-9][0-9]`));
    expect(loginPatterns()).toEqual(FLAVOR_KEYS.flatMap((k) => [`arashouse[_]${k}[_][0-9][0-9][_]dbo`, `arashouse[_]${k}[_][0-9][0-9][_]reg`]));
  });

  it("admits every slot database and login the tool derives, which the guards also admit", () => {
    for (const flavor of FLAVOR_KEYS) {
      for (let slot = 1; slot <= MAX_SLOT; slot++) {
        const db = databaseName({ flavor, slot });
        expect(dbAllowed(db), db).toBe(true);
        expect(assertOwned("database", db, { flavor, slot })).toBe(db);
        for (const role of ["dbo", "reg"] as const) expect(loginAllowed(loginName({ flavor, slot }, role))).toBe(true);
      }
    }
  });

  it("refuses the negative test's made-up names, the deny-list and the tool's other databases", () => {
    for (const name of [...negativeDatabaseNames(), ...DENIED_DATABASES, "arashouse_pp_23", "arashouse_build_23", "master", "tempdb"]) {
      expect(dbAllowed(name), JSON.stringify(name)).toBe(false);
    }
    for (const name of [...negativeLoginNames(), POOL_LOGIN, "sa", "arashouse_build_23_dbo"]) expect(loginAllowed(name), JSON.stringify(name)).toBe(false);
  });

  it("admits only the staged backup's own path to read_staged_backup", () => {
    // T-SQL LIKE in a binary collation: [..] a class, % any run, _ one character, anything else itself.
    const like = (pattern: string) =>
      new RegExp(
        `^${pattern.replace(/\[([^\]]+)\]|%|_|[^[%_]/g, (m, cls: string | undefined) =>
          cls !== undefined ? `[${cls.replace(/\\/g, "\\\\")}]` : m === "%" ? ".*" : m === "_" ? "." : m.replace(/[.*+?^${}()|\\/]/g, "\\$&"),
        )}$`,
      );
    const staged = (path: string) => path.length === path.trimEnd().length && like(stagedBackupPattern()).test(path);
    expect(stagedBackupPattern()).toBe(`C:\\aras[_]installations\\staging\\${"[0-9a-f]".repeat(32)}\\restore.bak`);
    expect(staged(stagedBackup("0123456789abcdef0123456789abcdef"))).toBe(true);
    for (const path of negativeStagedFiles()) expect(staged(path), JSON.stringify(path)).toBe(false);
    expect(procedures.read_staged_backup).toContain(`LIKE N'${stagedBackupPattern()}'`);
  });

  it("uses made-up names: none is a name the tool derives or one on the deny-list", () => {
    const derived = new Set(FLAVOR_KEYS.flatMap((flavor) => Array.from({ length: MAX_SLOT }, (_, i) => databaseName({ flavor, slot: i + 1 }))));
    for (const name of negativeDatabaseNames()) {
      expect(derived.has(name)).toBe(false);
      expect(DENIED_DATABASES.map((d) => d.toLowerCase())).not.toContain(name.toLowerCase());
    }
    expect(negativeDatabaseNames()).toContain(NEGATIVE_DATABASE);
  });
});

describe("setup-sql.ps1", () => {
  it("connects by shared memory with Windows authentication and no pooled session, and holds no credential", () => {
    expect(script).toContain("$ConnectionString = 'Data Source=lpc:.;Initial Catalog=master;Integrated Security=SSPI;Connect Timeout=10;Pooling=False;");
    expect(script).not.toMatch(/sqlcmd|User ID|\bUID=|Password=|-P\s|Read-Host|SecureString|ConvertTo-SecureString/i);
    expect(script).not.toMatch(/olm|prod\b|InnovatorSolutions|RabbitDemo/i);
    expect(script).toMatch(/^[\x00-\x7f]*$/);
  });

  it("lists databases only by the arashouse_ filter, and names each other database it reads", () => {
    for (const m of script.matchAll(/FROM sys\.databases([^\n]*)/g)) {
      // \$SlotDatabaseFilter is the slot databases' own patterns (likeAny, checked in the -Uninstall test below).
      expect(m[1], m[0]).toMatch(/WHERE (name LIKE N'arashouse\[_\]%'|name = @db|owner_sid = |database_id = DB_ID\(|name IN |\{0\} ORDER BY name" -f \$SlotDatabaseFilter)| d JOIN STRING_SPLIT/);
    }
    expect(script).toContain(`$SlotDatabaseFilter = '${likeAny("name", databasePatterns()).replace(/'/g, "''")}'`);
    expect(script).toContain("SELECT name FROM sys.databases WHERE name LIKE N'arashouse[_]%' ORDER BY name");
  });

  it("changes nothing outside an Invoke-Change block", () => {
    const changers = [
      "New-PoolLogin",
      "Enable-PoolLogin",
      "New-AdminDatabase",
      "Set-AdminDatabaseSafe",
      "Set-PoolUser",
      "Build-Procedures",
      "Grant-Procedures",
      "Remove-AdminDatabase",
      "Remove-SignerLogin",
      "Remove-MasterCertificate",
      "Remove-PoolLogin",
    ];
    for (const fn of changers) {
      const uses = script.split("\n").filter((l) => l.includes(fn) && !l.startsWith(`function ${fn}`));
      expect(uses.length, fn).toBeGreaterThan(0);
      for (const use of uses) expect(use, fn).toMatch(new RegExp(`Invoke-Change .*\\{ ${fn}\\b`));
    }
    // The checks write only the self-test's and the negative test's own throw-away names.
    const drops = script.split("\n").filter((l) => /DROP (DATABASE|LOGIN)/.test(l) && l.includes("Invoke-Sql"));
    expect(drops.length).toBeGreaterThan(0);
    for (const l of drops) expect(l).toMatch(/\$signer|\$Name\)|\$SelfTestLogin|\$SelfTestDatabase|\$NegativeDatabase|\$AdminDatabase|\$PoolLogin|DROP PROCEDURE/);
  });

  it("-Uninstall drops only the objects -Apply made, and refuses while a slot's database or login is left (ticket 49)", () => {
    expect(script).toMatch(/param\(\s*\[switch\]\$Apply,\s*\[switch\]\$SelfTest,\s*\[switch\]\$Uninstall\s*\)/);
    expect(script).toContain("if ($Uninstall -and $SelfTest) { Fail 2 '-Uninstall takes only -Apply' }");
    // Each drop names one of the script's own objects, and nothing else.
    const bodyOf = (fn: string) => script.slice(script.indexOf(`function ${fn}`), script.indexOf("\n}\n", script.indexOf(`function ${fn}`)));
    expect(bodyOf("Remove-AdminDatabase")).toMatch(/DROP DATABASE \[\{0\}\];' -f \$AdminDatabase\)$/m);
    expect(bodyOf("Remove-SignerLogin")).toContain("('DROP LOGIN [{0}];' -f $Name)");
    expect(bodyOf("Remove-MasterCertificate")).toContain("('DROP CERTIFICATE [{0}];' -f $Name)");
    // ... and only for a certificate of the script's own, by its name.
    expect(bodyOf("Get-UninstallState")).toContain("$s.signerLogins = @($Signers.Keys | Where-Object");
    expect(bodyOf("Get-UninstallState")).toContain("$s.masterCertificates = @($Signers.Keys | Where-Object");
    expect(bodyOf("Remove-PoolLogin")).toContain("SELECT QUOTENAME(@login)' @{ login = $PoolLogin }");
    expect(bodyOf("Remove-PoolLogin")).toContain("KILL {0};' -f [int]$spid");
    // The refusal: slot databases and logins by the procedures' own patterns, read in a binary collation.
    const uninstall = bodyOf("Invoke-Uninstall");
    expect(uninstall.indexOf("if ($blocked.Count -gt 0)")).toBeLessThan(uninstall.indexOf("Invoke-Change"));
    expect(uninstall).toContain("return $state\n    }");
    for (const p of [...databasePatterns(), ...loginPatterns()]) expect(script).toContain(`name COLLATE Latin1_General_BIN2 LIKE N''${p}''`);
    expect(bodyOf("Get-UninstallState")).toContain("SELECT name FROM sys.databases WHERE {0} ORDER BY name\" -f $SlotDatabaseFilter");
    expect(bodyOf("Get-UninstallState")).toContain("SELECT name FROM sys.server_principals WHERE {0} ORDER BY name\" -f $SlotLoginFilter");
    // An arashouse_admin whose data file is elsewhere is not the one this script made: refused, not dropped.
    expect(uninstall).toContain("$state.adminDataFile -ne $AdminDataFile");
    // The uninstall branch ends the script before the install's changes and checks.
    const branch = script.indexOf("if ($Uninstall) {\n    $state = $null");
    expect(branch).toBeGreaterThan(-1);
    expect(script.indexOf("exit 0", branch)).toBeLessThan(script.indexOf("$state = Get-State\n", branch));
  });

  it("gives a secret of the run only to SQL as a parameter, and redacts it from errors", () => {
    const allowedUses = [
      /^\$(secret|password) = New-Secret$/,
      /\$(secret|password) = \$null/,
      /@\{ secret = \$secret \}/,
      /@\{ name = \$name; password = \$password \}/,
      /@\{ l = \$SelfTestLogin; p = \$password \}/,
      /Get-ErrorText \$_ @\(\$(secret|password)\)/,
    ];
    const uses = script.split("\n").filter((l) => /\$(secret|password)\b/.test(l));
    expect(uses.length).toBeGreaterThan(5);
    for (const line of uses) expect(allowedUses.some((r) => r.test(line.trim())), line).toBe(true);
    expect(script).not.toMatch(/Write-Host[^\n]*\$(secret|password)/);
  });

  it("checks the pool login's roles and rights as that login, and the refusals with the made-up names", () => {
    expect(script).toContain(`EXECUTE AS LOGIN = N'${POOL_LOGIN}';`);
    expect(script).toContain("IS_SRVROLEMEMBER('sysadmin') AS sysadmin, IS_SRVROLEMEMBER('dbcreator') AS dbcreator");
    for (const p of [...SIGNER_PERMISSIONS, ...ADOPTER_PERMISSIONS]) expect(script).toContain(`HAS_PERMS_BY_NAME(NULL, NULL, N'${p}')`);
    for (const p of ADMIN_PROCEDURES) expect(script).toContain(`$NegativeCall['${p}'] = @'`);
    expect(script).toContain(`RESTORE DATABASE [${NEGATIVE_DATABASE}] FROM DISK = N'C:\\aras_installations\\staging\\arashouse-negative-madeup\\${NEGATIVE_DATABASE}.bak' WITH REPLACE;`);
    expect(script).toContain("$SelfTestDatabase = 'arashouse_35_99'");
    expect(SELF_TEST_SLOT).toEqual({ flavor: FLAVOR_KEYS[FLAVOR_KEYS.length - 1], slot: MAX_SLOT });
  });

  it("grants each certificate's login only the rights its procedures need, and removes its private key", () => {
    expect(script).toContain(
      "'arashouse_admin_signer' = [ordered]@{ permissions = @('CREATE ANY DATABASE', 'ALTER ANY CONNECTION', 'ALTER ANY LOGIN', 'VIEW SERVER STATE'); " +
        "procedures = @('create_slot_database', 'drop_slot_database', 'kill_connections', 'create_slot_login', 'drop_slot_login', 'read_staged_backup') }",
    );
    // CONTROL SERVER (ticket 39) on a certificate of its own, which signs adopt_slot_database and nothing else.
    expect(script).toContain("'arashouse_admin_adopter' = [ordered]@{ permissions = @('CONTROL SERVER'); procedures = @('adopt_slot_database') }");
    expect(SIGNERS.flatMap((s) => s.procedures).sort()).toEqual([...ADMIN_PROCEDURES].sort());
    expect(SIGNERS.filter((s) => s.permissions.includes("CONTROL SERVER")).map((s) => s.procedures)).toEqual([["adopt_slot_database"]]);
    // A procedure counts as current only when signed once, by its own certificate.
    expect(script).toContain("if ($p.signatures -ne 1 -or $p.signer -ne $ProcedureSigner[$p.name]) { $s.procedures.unsigned += $p.name; continue }");
    expect(script).toContain("ALTER CERTIFICATE [{0}] REMOVE PRIVATE KEY;");
    expect(script).toContain("CREATE LOGIN [{0}] FROM CERTIFICATE [{0}];");
    expect(script).toContain("SET TRUSTWORTHY OFF");
    expect(script).not.toMatch(/TRUSTWORTHY ON|sp_addsrvrolemember|ADD MEMBER|CONTROL SERVER TO|IMPERSONATE/);
  });

  it("refuses an unusable version, root or data source", () => {
    expect(() => renderSetupSqlScript({ version: "1 2" })).toThrow(/version/);
    expect(() => renderSetupSqlScript({ version: "0", root: "C:\\Program Files\\x" })).toThrow();
    expect(() => renderSetupSqlScript({ version: "0", dataSource: "tcp:somewhere,1433" })).toThrow(/data source/);
    expect(renderSetupSqlScript({ version: "0", dataSource: "(localdb)\\ah22" })).toContain("Data Source=(localdb)\\ah22;");
  });
});

describe("checkSqlLogin", () => {
  const login = { login: POOL_LOGIN, sysadmin: false, dbcreator: false, procedures: ADMIN_PROCEDURES.length };
  it("is ok only for a login in neither role that executes every procedure", () => {
    expect(checkSqlLogin({ sqlReachable: true, sqlLogin: login }).map((f) => f.level)).toEqual(["ok", "ok"]);
    expect(checkSqlLogin({ sqlReachable: true, sqlLogin: { ...login, sysadmin: true } })[1]?.level).toBe("fail");
    expect(checkSqlLogin({ sqlReachable: true, sqlLogin: { ...login, dbcreator: true } })[1]?.level).toBe("fail");
    expect(checkSqlLogin({ sqlReachable: true, sqlLogin: { ...login, procedures: 4 } })[1]?.level).toBe("fail");
    expect(checkSqlLogin({ sqlReachable: true })[1]?.level).toBe("warn");
    expect(checkSqlLogin({ sqlReachable: false, sqlLogin: login })).toEqual([expect.objectContaining({ level: "fail", check: "sql" })]);
  });
});
