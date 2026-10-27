// The baseline build's steps, in order (ticket 24, docs/baselines.md). It runs on Windows in the
// captain's elevated session (`baseline-build.ps1` starts it under Node): the broker cannot do it,
// since its SQL login may not create the build's database (ticket 22). Every effect goes through a
// `BuildSystem`: build-system.ts on the host, a fake in the tests.
//
// A failure from the first step that changes the host onwards removes the throw-away instance and
// whatever of the new golden was assembled, puts a replaced golden back, and re-checks the deny-list.
// Nothing is ever written into `golden\<key>` but by the last move, so a failed build leaves the old
// golden (or none) as it was.

import { randomBytes } from "node:crypto";
import { win32 } from "node:path";
import {
  BUILD_STEPS,
  SHIPPED_ADMIN_LOGIN,
  compareDenyList,
  flavorRecord,
  goldenJson,
  type BaselinePlan,
  type BuildReport,
  type BuildStep,
  type DenyListSnapshot,
  type IisApplication,
  type IisRecord,
  type ServiceRecord,
  type StepRecord,
} from "../core/baseline.js";
import { EDIT_LIST_SCHEMA, innovatorServerUrl, renderFile, serializeEditList, type Edit, type EditList, type EditSecrets, type EditVars } from "../core/edits.js";
import { editList } from "../core/edit-lists.js";
import { decodeText, parseXmlSelector, selectXml } from "../core/config-text.js";
import type { Manifest } from "../core/manifest.js";
import { redact } from "../core/redact.js";
import { Secret } from "../core/secret.js";
import { parseDbList } from "../host/probe.js";
import type { HttpAnswer } from "../host/http.js";

/** The build's own SQL login passwords: generated per build, gone with the instance. */
export interface BuildLogins {
  readonly dbo: Secret;
  readonly reg: Secret;
}

/**
 * The `<License>` element a login needs. The key alone is refused ("License Key is invalid", the first login proof):
 * the server checks `lic_key` with `act_key`, `lic_type` and `company`, which spike 30 copied together.
 */
export interface LicenceInput {
  readonly key: Secret;
  readonly actKey?: Secret;
  readonly type?: string;
  readonly company?: string;
}

/** What the person running the build supplied for the login check; both or neither are needed. */
export interface BuildInputs {
  readonly licence?: LicenceInput;
  readonly adminPassword?: Secret;
}

/**
 * The licence as `baseline-build.ps1` hands it over: the key alone (a hidden prompt), or the JSON object
 * `{ "lic_key", "act_key", "lic_type", "company" }` of a `<License>` element (a file). Throws on anything else.
 */
export function parseLicenceInput(secret: Secret): LicenceInput {
  const text = secret.reveal().trim();
  if (!text.startsWith("{")) return { key: secret };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("the licence input is neither a key nor a JSON <License> element");
  }
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" && (r[k] as string).length > 0 ? (r[k] as string) : undefined);
  const key = str("lic_key");
  if (!key) throw new Error("the licence input's <License> element has no lic_key");
  const actKey = str("act_key");
  for (const k of ["lic_type", "company"]) if (/\{\{|\}\}/.test(str(k) ?? "")) throw new Error(`the licence input's ${k} holds a template brace`);
  return {
    key: Secret.of(key, "licence"),
    ...(actKey ? { actKey: Secret.of(actKey, "licence") } : {}),
    ...(str("lic_type") ? { type: str("lic_type") } : {}),
    ...(str("company") ? { company: str("company") } : {}),
  };
}

export interface CopyResult {
  readonly files: number;
  readonly bytes: number;
}

/** Every effect the build has on the host. Paths are Windows paths the plan derived. */
export interface BuildSystem {
  /** Milliseconds, for the step timings. */
  now(): number;
  /** The prerequisite ids `setup-host.ps1` last found missing, or null when it has left no record. */
  missingPrerequisites(): Promise<readonly string[] | null>;
  freeDiskGb(): Promise<number>;
  exists(path: string): Promise<boolean>;
  sha256(path: string): Promise<string>;
  /** Names of the throw-away instance's objects that exist: folders, alias, pools, database, logins, product, service. */
  survey(plan: BaselinePlan): Promise<readonly string[]>;
  snapshotDenyList(): Promise<DenyListSnapshot>;
  /** Copies the MSI into `scratch.msiDir` with a new ProductCode; returns the copy's path. */
  copyMsi(plan: BaselinePlan): Promise<string>;
  /** Costs the copy without installing it; returns the folder keys that resolve outside the build's own folders. */
  costMsi(plan: BaselinePlan, msi: string): Promise<readonly string[]>;
  /** Installs unattended; the log is read for failed actions and deleted. */
  installMsi(plan: BaselinePlan, msi: string): Promise<{ readonly exitCode: number; readonly failedActions: readonly string[] }>;
  /** Moves each application of the build alias to its own pool `<alias>-<role>`; returns the layout. */
  ownPools(plan: BaselinePlan): Promise<readonly IisApplication[]>;
  /** Creates the build's two logins, restores the shipped backup and maps its users to them. */
  restoreDatabase(plan: BaselinePlan, logins: BuildLogins): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** One anonymous GET (no redirects); the body only when asked. */
  get(url: string, readBody: boolean): Promise<HttpAnswer>;
  sleep(ms: number): Promise<void>;
  /** An OAuth password grant as `user` against the build's own OAuth server; never returns the token. */
  login(plan: BaselinePlan, user: string, password: Secret): Promise<{ readonly ok: boolean; readonly detail: string }>;
  /** `Aras.Server.Core.dll`'s file version, or null when the file is missing. */
  serverVersion(plan: BaselinePlan): Promise<string | null>;
  stopPools(plan: BaselinePlan): Promise<void>;
  /** Copies the install directory to the candidate's `tree\` (times kept, no junction followed, the install's `DB\` left out). */
  copyTree(plan: BaselinePlan): Promise<CopyResult>;
  copyFile(from: string, to: string): Promise<void>;
  /** A `COPY_ONLY` backup of the build database to `plan.backupScratch`. */
  backupDatabase(plan: BaselinePlan): Promise<void>;
  fileSize(path: string): Promise<number>;
  removeFile(path: string): Promise<void>;
  removeDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  buildManifest(plan: BaselinePlan, tree: string, serverBuild: string): Promise<Manifest>;
  writeManifest(file: string, manifest: Manifest): Promise<void>;
  /** Removes the alias, pools, database, logins, product registration and service; returns what is still there. */
  removeThrowaway(plan: BaselinePlan): Promise<readonly string[]>;
  /** Gives `golden\<key>` its read-only ACL: the broker reads, only the elevated build writes. */
  seal(plan: BaselinePlan): Promise<void>;
}

export interface BuildOptions {
  readonly inputs?: BuildInputs;
  /** Free disk the build needs at the root (config `min_free_disk_gb`). */
  readonly minFreeDiskGb: number;
  /** ISO time the report records as the start; defaults to now. */
  readonly startedAt?: string;
  /** Called with each step's record as it ends, for the console. */
  readonly onStep?: (record: StepRecord) => void;
}

/** A step failed; the message is one redacted line. */
export class BuildStepError extends Error {
  constructor(
    readonly step: BuildStep,
    message: string,
  ) {
    super(redact(message));
    this.name = "BuildStepError";
  }
}

const LOGIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** A random 24-character SQL login password (letters and digits, no quote to escape). */
export function newLoginPassword(): Secret {
  const bytes = randomBytes(24);
  return Secret.of(Array.from(bytes, (b) => LOGIN_ALPHABET[b % LOGIN_ALPHABET.length]).join(""), "sql-login");
}

/** The template variables for the build instance itself: its names stand where a slot's would. */
export function buildEditVars(plan: BaselinePlan): EditVars {
  const n = plan.names;
  return {
    alias: n.alias,
    database: n.database,
    "login.dbo": plan.scratch.logins.dbo,
    "login.reg": plan.scratch.logins.reg,
    agentPort: String(n.agentPort),
    slotDir: n.dir,
    vaultDir: plan.scratch.vaultRoot,
    serverUrl: innovatorServerUrl(n.alias),
    "build.alias": n.alias,
    "build.database": n.database,
    "build.dir": n.dir,
    "build.agentPort": String(n.agentPort),
  };
}

const SERVER_CONFIG = "InnovatorServerConfig.xml";

/** The values of the build's server config that a check needs: set for the checks, then put back or blanked before the copy. */
interface ConfigValues {
  readonly dbo: string;
  readonly reg: string;
  readonly licence: string;
  /** Absent: the attribute is left as it is. */
  readonly actKey?: string;
  readonly type?: string;
  readonly company?: string;
}

function configEdits(values: ConfigValues): Edit[] {
  const licence = (attr: string, value: string | undefined): Edit[] =>
    value === undefined ? [] : [{ file: SERVER_CONFIG, kind: "xml", path: `/Innovator/License/@${attr}`, value }];
  return [
    { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/DB-Connection/@dbo_pwd", value: values.dbo },
    { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/DB-Connection/@regular_pwd", value: values.reg },
    { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/License/@lic_key", value: values.licence },
    ...licence("act_key", values.actKey),
    ...licence("lic_type", values.type),
    ...licence("company", values.company),
  ];
}

/** The `<License>` attributes the MSI wrote, which the build puts back before the copy. */
function licenceAttributes(bytes: Uint8Array): Record<"lic_type" | "company", string> {
  const { text } = decodeText(bytes);
  const read = (attr: string) => selectXml(text, parseXmlSelector(`/Innovator/License/@${attr}`))[0]?.value ?? "";
  return { lic_type: read("lic_type"), company: read("company") };
}

interface RunState {
  installStarted: boolean;
  promoted: boolean;
  retired: boolean;
  goldenHash: string | null;
  serverBuild: string | null;
  applications: readonly IisApplication[];
  denyBefore: DenyListSnapshot | null;
  logins: BuildLogins | null;
  loginChecked: boolean;
  tree: { files: number; bytes: number } | null;
  licenceOriginal: Record<"lic_type" | "company", string> | null;
}

/** Runs the build of `plan`. Never throws: the report says what happened. */
export async function runBaselineBuild(system: BuildSystem, plan: BaselinePlan, options: BuildOptions): Promise<BuildReport> {
  const started = system.now();
  const startedAt = options.startedAt ?? new Date(started).toISOString();
  const steps: StepRecord[] = [];
  const state: RunState = {
    installStarted: false,
    promoted: false,
    retired: false,
    goldenHash: null,
    serverBuild: plan.serverBuild,
    applications: [],
    denyBefore: null,
    logins: null,
    loginChecked: false,
    tree: null,
    licenceOriginal: null,
  };
  const inputs = options.inputs ?? {};
  let msiCopy = "";

  const work: Record<BuildStep, () => Promise<string>> = {
    preflight: () => preflight(system, plan, options),
    snapshot: async () => {
      state.denyBefore = await system.snapshotDenyList();
      return `${Object.keys(state.denyBefore).length} deny-list objects fingerprinted (names only)`;
    },
    "msi-copy": async () => {
      state.installStarted = true;
      const msi = await system.copyMsi(plan);
      msiCopy = msi;
      return `copied the MSI with a new ProductCode to ${msi}`;
    },
    "msi-cost": async () => {
      const outside = await system.costMsi(plan, msiCopy);
      if (outside.length > 0) throw new BuildStepError("msi-cost", `costing resolves ${outside.length} folders outside the build's own (for example ${outside[0]}); nothing was installed`);
      return "every folder the MSI writes resolves under golden-build\\";
    },
    install: async () => {
      const { exitCode, failedActions } = await system.installMsi(plan, msiCopy);
      const failed = failedActions.length > 0 ? `; failed actions: ${failedActions.join(", ")}` : "";
      // 3010 and 1641: it wanted a restart, which REBOOT=ReallySuppress held back.
      if (exitCode !== 0 && exitCode !== 3010 && exitCode !== 1641) throw new BuildStepError("install", `the MSI returned ${exitCode}${failed}`);
      return `installed (MSI exit ${exitCode}${exitCode === 0 ? "" : ", restart suppressed"})${failed}`;
    },
    pools: async () => {
      state.applications = await system.ownPools(plan);
      if (state.applications.length === 0) throw new BuildStepError("pools", `IIS has no application under /${plan.names.alias}`);
      return `${state.applications.length} applications, each on its own pool ${plan.scratch.poolPrefix}<role>`;
    },
    database: async () => {
      state.logins = { dbo: newLoginPassword(), reg: newLoginPassword() };
      await system.restoreDatabase(plan, state.logins);
      return `restored ${win32.basename(plan.media.coreAndSolutions)} as ${plan.names.database}, its users mapped to ${plan.scratch.logins.dbo} and ${plan.scratch.logins.reg}`;
    },
    configure: async () => {
      const logins = state.logins as BuildLogins;
      const l = inputs.licence;
      state.licenceOriginal = licenceAttributes(await system.readFile(win32.join(plan.names.dir, SERVER_CONFIG)));
      const values: ConfigValues = {
        dbo: "{{secret:db_dbo_password}}",
        reg: "{{secret:db_reg_password}}",
        licence: l ? "{{secret:licence}}" : "",
        ...(l?.actKey ? { actKey: "{{secret:licence_act_key}}" } : {}),
        ...(l?.type !== undefined ? { type: l.type } : {}),
        ...(l?.company !== undefined ? { company: l.company } : {}),
      };
      const outcomes = await renderConfig(system, plan, configEdits(values), {
        db_dbo_password: logins.dbo,
        db_reg_password: logins.reg,
        ...(l ? { licence: l.key } : {}),
        ...(l?.actKey ? { licence_act_key: l.actKey } : {}),
      });
      return `set the build's SQL passwords${inputs.licence ? " and licence key" : ""} in ${SERVER_CONFIG} (${outcomes})`;
    },
    verify: () => verify(system, plan, inputs, state),
    stop: async () => {
      await system.stopPools(plan);
      return `stopped the ${plan.scratch.poolPrefix}* pools`;
    },
    "blank-secrets": async () => {
      const l = inputs.licence;
      const original = state.licenceOriginal ?? { lic_type: "", company: "" };
      const values: ConfigValues = {
        dbo: "",
        reg: "",
        licence: "",
        ...(l?.actKey ? { actKey: "" } : {}),
        ...(l?.type !== undefined ? { type: original.lic_type } : {}),
        ...(l?.company !== undefined ? { company: original.company } : {}),
      };
      const outcomes = await renderConfig(system, plan, configEdits(values), {});
      return `blanked the SQL passwords and the licence in the build's ${SERVER_CONFIG} before the copy (${outcomes})`;
    },
    "capture-tree": async () => {
      if (await system.exists(plan.scratch.candidateDir)) await system.removeDir(plan.scratch.candidateDir);
      state.tree = await system.copyTree(plan);
      const leaks = await secretsIn(system, plan, plan.candidate.tree, [state.logins?.dbo, state.logins?.reg, inputs.licence?.key, inputs.licence?.actKey, inputs.adminPassword]);
      if (leaks.length > 0) throw new BuildStepError("capture-tree", `a secret of this build is in the copied ${leaks.join(", ")}`);
      return `copied ${state.tree.files} files (${mb(state.tree.bytes)} MB) to the new golden's tree; no secret of this build in its configs`;
    },
    "capture-db": async () => {
      await system.copyFile(plan.media.core, win32.join(plan.candidate.db, win32.basename(plan.media.core)));
      await system.copyFile(plan.media.coreAndSolutions, win32.join(plan.candidate.db, win32.basename(plan.media.coreAndSolutions)));
      await system.backupDatabase(plan);
      await system.copyFile(plan.backupScratch, plan.candidate.ootbBackup);
      await system.removeFile(plan.backupScratch);
      return `copied the shipped backups and a COPY_ONLY backup of ${plan.names.database} (ootb.bak, ${mb(await system.fileSize(plan.candidate.ootbBackup))} MB)`;
    },
    metadata: async () => {
      const iis: IisRecord = { schema: 1, site: "Default Web Site", applications: state.applications };
      // INSTALL_AGENT_SERVICE=0: the build installs no agent (spike record, section 1).
      const service: ServiceRecord = { schema: 1, installed: false, name: null, binaryPath: null, startMode: null };
      await system.writeFile(plan.candidate.edits, serializeEditList(editList(plan.flavor)));
      await system.writeFile(plan.candidate.iis, goldenJson(iis));
      await system.writeFile(plan.candidate.service, goldenJson(service));
      return "wrote edits.json, iis.json and service.json";
    },
    manifest: async () => {
      const serverBuild = state.serverBuild as string;
      const manifest = await system.buildManifest(plan, plan.candidate.tree, serverBuild);
      await system.writeManifest(plan.candidate.manifest, manifest);
      const backups = [];
      for (const file of [plan.media.core, plan.media.coreAndSolutions, plan.candidate.ootbBackup]) {
        const inDb = win32.join(plan.candidate.db, win32.basename(file));
        backups.push({ file: win32.basename(file), bytes: await system.fileSize(inDb), sha256: await system.sha256(inDb) });
      }
      const record = flavorRecord(plan, {
        serverBuild,
        builtAt: startedAt,
        buildSeconds: Math.round((system.now() - started) / 1000),
        tree: { files: manifest.fileCount, bytes: manifest.totalBytes },
        backups,
        manifestHash: manifest.manifestHash,
      });
      await system.writeFile(plan.candidate.flavor, goldenJson(record));
      state.goldenHash = manifest.manifestHash;
      return `manifest of ${manifest.fileCount} files (${mb(manifest.totalBytes)} MB), hash ${manifest.manifestHash.slice(0, 12)}; wrote flavor.json`;
    },
    promote: async () => {
      await system.writeFile(plan.scratch.promotingMarker, startedAt);
      try {
        if (await system.exists(plan.golden.dir)) {
          if (!plan.replace) throw new BuildStepError("promote", `${plan.golden.dir} appeared during the build; it is left as it is`);
          if (await system.exists(plan.scratch.retiredDir)) await system.removeDir(plan.scratch.retiredDir);
          await system.rename(plan.golden.dir, plan.scratch.retiredDir);
          state.retired = true;
        }
        await system.rename(plan.scratch.candidateDir, plan.golden.dir);
        state.promoted = true;
        if (state.retired) {
          await system.removeDir(plan.scratch.retiredDir);
          state.retired = false;
        }
      } finally {
        await system.removeFile(plan.scratch.promotingMarker);
      }
      return `moved the new golden into ${plan.golden.dir}${plan.replace ? " (replacing the old one)" : ""}`;
    },
    remove: async () => {
      const left = await removeAll(system, plan);
      if (left.length > 0) throw new BuildStepError("remove", `the throw-away instance is not all gone: ${left.join(", ")}`);
      return `removed /${plan.names.alias}, its pools, ${plan.names.database}, its logins, the product registration and golden-build\\${plan.flavor}*`;
    },
    "deny-list": async () => {
      const diff = compareDenyList(state.denyBefore ?? {}, await system.snapshotDenyList());
      if (!diff.ok) {
        const parts = [diff.changed.length ? `changed ${diff.changed.join(", ")}` : "", diff.missing.length ? `gone ${diff.missing.join(", ")}` : "", diff.added.length ? `new ${diff.added.join(", ")}` : ""];
        throw new BuildStepError("deny-list", `deny-list objects differ from before the build: ${parts.filter(Boolean).join("; ")}`);
      }
      return `${Object.keys(state.denyBefore ?? {}).length} deny-list objects unchanged`;
    },
    seal: async () => {
      await system.seal(plan);
      return `${plan.golden.dir} is read-only for the broker`;
    },
  };

  let failure: BuildStepError | null = null;
  for (const step of BUILD_STEPS) {
    if (failure) {
      steps.push({ step, status: "skipped", seconds: 0, detail: "not run: an earlier step failed" });
      continue;
    }
    const at = system.now();
    try {
      const detail = redact(await work[step]());
      record(steps, { step, status: "ok", seconds: secondsSince(system, at), detail }, options);
    } catch (err) {
      failure = err instanceof BuildStepError ? err : new BuildStepError(step, err instanceof Error ? err.message : String(err));
      record(steps, { step, status: "failed", seconds: secondsSince(system, at), detail: failure.message }, options);
    }
  }

  let leftovers: string[] = [];
  if (failure && state.installStarted) leftovers = await cleanUp(system, plan, state);
  return {
    ok: failure === null,
    flavor: plan.flavor,
    startedAt,
    seconds: secondsSince(system, started),
    steps,
    goldenHash: state.promoted ? state.goldenHash : null,
    loginChecked: state.loginChecked,
    error: failure ? `${failure.step}: ${failure.message}` : null,
    leftovers,
  };
}

/** Removes a throw-away instance a failed build left, and nothing else (`baseline-build.ps1 -Cleanup`). */
export async function runBuildCleanup(system: BuildSystem, plan: BaselinePlan): Promise<readonly string[]> {
  return removeAll(system, plan);
}

function record(steps: StepRecord[], entry: StepRecord, options: BuildOptions): void {
  steps.push(entry);
  options.onStep?.(entry);
}

function secondsSince(system: BuildSystem, at: number): number {
  return Math.round((system.now() - at) / 100) / 10;
}

function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

async function preflight(system: BuildSystem, plan: BaselinePlan, options: BuildOptions): Promise<string> {
  const missing = await system.missingPrerequisites();
  if (missing === null) throw new BuildStepError("preflight", "no setup record (broker\\setup-host.json): run `arashouse setup` and its script first");
  const needed = missing.filter((id) => (plan.prerequisites as readonly string[]).includes(id));
  if (needed.length > 0) throw new BuildStepError("preflight", `prerequisites missing for ${plan.flavor}: ${needed.join(", ")} (install them; the tool never does)`);
  const free = await system.freeDiskGb();
  if (free < options.minFreeDiskGb) throw new BuildStepError("preflight", `${free} GB free at the root, under min_free_disk_gb ${options.minFreeDiskGb}`);
  for (const file of [plan.media.msi, plan.media.core, plan.media.coreAndSolutions]) {
    if (!(await system.exists(file))) throw new BuildStepError("preflight", `the bundle has no ${file}: run \`arashouse baseline build ${plan.flavor}\` again`);
  }
  if ((await system.sha256(plan.media.msi)) !== plan.msiSha256) throw new BuildStepError("preflight", "the bundle's MSI is not the one `arashouse baseline build` checked (SHA-256 differs)");
  if ((await system.exists(plan.golden.dir)) && !plan.replace) {
    throw new BuildStepError("preflight", `the ${plan.flavor} golden already exists; a rebuild replaces it only with -Replace (every slot of ${plan.flavor} is then reset from the new one)`);
  }
  const leftovers = await system.survey(plan);
  if (leftovers.length > 0) throw new BuildStepError("preflight", `an earlier build left ${leftovers.join(", ")}; remove it with -Cleanup first`);
  return `prerequisites present, ${free} GB free, media match, ${plan.replace ? "replacing the golden" : "no golden yet"}, no throw-away instance`;
}

async function renderConfig(system: BuildSystem, plan: BaselinePlan, edits: Edit[], secrets: EditSecrets): Promise<string> {
  const file = win32.join(plan.names.dir, SERVER_CONFIG);
  const list: EditList = { schema: EDIT_LIST_SCHEMA, flavor: plan.flavor, edits };
  const result = renderFile(SERVER_CONFIG, await system.readFile(file), list, buildEditVars(plan), secrets);
  if (result.changed) await system.writeFile(file, result.bytes);
  const applied = result.outcomes.filter((o) => o.status === "applied").length;
  return `${applied} applied, ${result.outcomes.length - applied} already`;
}

async function verify(system: BuildSystem, plan: BaselinePlan, inputs: BuildInputs, state: RunState): Promise<string> {
  const base = `http://localhost/${plan.names.alias}`;
  const problems: string[] = [];
  // DBList.aspx is installed in Innovator\Server, the `/Server` application (the MSI's File table).
  const dbList = await answered(system, `${base}/Server/DBList.aspx`);
  const ids = dbList.status === 200 ? parseDbList(dbList.body ?? "") : [];
  if (dbList.status !== 200) problems.push(`DBList.aspx: ${failure(dbList)}`);
  else if (ids.length !== 1 || ids[0] !== plan.names.database) problems.push(`DBList.aspx lists ${ids.length} databases, not just ${plan.names.database}`);
  const oauth = await answered(system, `${base}/OAuthServer/.well-known/openid-configuration`);
  if (oauth.status !== 200) problems.push(`OAuth discovery: ${failure(oauth)}`);
  const version = await system.serverVersion(plan);
  if (version === null) problems.push("no Aras.Server.Core.dll in the installed tree");
  else if (plan.serverBuild !== null && version !== plan.serverBuild) problems.push(`the server is ${version}, the registry says ${plan.serverBuild}`);
  else state.serverBuild = version;
  let login = "login skipped: it needs the line's licence key and the shipped admin password (-LicenceFile, -AdminPasswordFile)";
  if (inputs.licence && inputs.adminPassword) {
    const answer = await system.login(plan, SHIPPED_ADMIN_LOGIN, inputs.adminPassword);
    if (!answer.ok) problems.push(`login as ${SHIPPED_ADMIN_LOGIN}: ${answer.detail}`);
    else {
      state.loginChecked = true;
      login = `logged in as ${SHIPPED_ADMIN_LOGIN}`;
    }
  }
  if (problems.length > 0) throw new BuildStepError("verify", problems.join("; "));
  return `DBList.aspx lists ${plan.names.database}; OAuth discovery answers; server ${version}; ${login}`;
}

/** A freshly installed application can answer 500 or 503 while it first starts: ask again for up to a minute. */
const ANSWER_ATTEMPTS = 6;
const ANSWER_PAUSE_MS = 10_000;

async function answered(system: BuildSystem, url: string): Promise<HttpAnswer> {
  let answer = await system.get(url, true);
  for (let i = 1; i < ANSWER_ATTEMPTS && answer.status !== 200 && (answer.status === undefined || answer.status >= 500); i++) {
    await system.sleep(ANSWER_PAUSE_MS);
    answer = await system.get(url, true);
  }
  return answer;
}

/** Why an answer is not 200: the status and IIS's own error number when its error page names one (`HTTP Error 500.19`), never the body. */
function failure(answer: HttpAnswer): string {
  if (answer.status === undefined) return answer.error ?? "no answer";
  const iis = /HTTP Error (\d{3}\.\d{1,3})/.exec(answer.body ?? "")?.[1];
  return `HTTP ${answer.status}${iis ? ` (IIS ${iis})` : ""}`;
}

/** The config files under `tree` that hold the value of any of `secrets` (relative paths only). */
async function secretsIn(system: BuildSystem, plan: BaselinePlan, tree: string, secrets: readonly (Secret | undefined)[]): Promise<string[]> {
  const files = editList(plan.flavor).edits.map((e) => e.file);
  const values = secrets.filter((s): s is Secret => s !== undefined && s.length > 0).map((s) => Buffer.from(s.reveal(), "utf8"));
  const hits: string[] = [];
  for (const rel of [...new Set(files)]) {
    const path = win32.join(tree, ...rel.split("/"));
    if (!(await system.exists(path))) continue;
    const bytes = Buffer.from(await system.readFile(path));
    if (values.some((v) => bytes.includes(v))) hits.push(rel);
  }
  return hits;
}

async function removeAll(system: BuildSystem, plan: BaselinePlan): Promise<string[]> {
  const left = [...(await system.removeThrowaway(plan))];
  for (const dir of [plan.names.dir, plan.scratch.msiDir, plan.scratch.vaultRoot, plan.scratch.candidateDir]) {
    try {
      if (await system.exists(dir)) await system.removeDir(dir);
    } catch {
      // Reported below by name.
    }
    if (await system.exists(dir).catch(() => true)) left.push(dir);
  }
  return left;
}

async function cleanUp(system: BuildSystem, plan: BaselinePlan, state: RunState): Promise<string[]> {
  const left: string[] = [];
  try {
    if (state.retired && !(await system.exists(plan.golden.dir))) {
      await system.rename(plan.scratch.retiredDir, plan.golden.dir);
      state.retired = false;
    }
  } catch (err) {
    left.push(`${plan.scratch.retiredDir} (the replaced golden; move it back to ${plan.golden.dir}): ${redact(err instanceof Error ? err.message : String(err))}`);
  }
  try {
    left.push(...(await removeAll(system, plan)));
  } catch (err) {
    left.push(`the throw-away instance: ${redact(err instanceof Error ? err.message : String(err))}`);
  }
  if (state.denyBefore) {
    try {
      const diff = compareDenyList(state.denyBefore, await system.snapshotDenyList());
      if (!diff.ok) left.push(`deny-list objects differ: ${[...diff.changed, ...diff.missing, ...diff.added].join(", ")}`);
    } catch (err) {
      left.push(`the deny-list re-check: ${redact(err instanceof Error ? err.message : String(err))}`);
    }
  }
  return left;
}
