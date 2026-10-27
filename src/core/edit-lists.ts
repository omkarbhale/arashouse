// The per-flavor config edit lists (the engine is edits.ts; docs/edits.md). Data only. The baseline
// builder (ticket 24) writes a flavor's list to `golden\<key>\edits.json`.
//
// 12sp9 and 23: the eight files ticket 09's spike record lists, the same for both (spikes 05 and 07,
// `spike/20-clone-slot.ps1`), with the attribute names read from the spike installs' configs and,
// for `SelfServiceReportConfig.xml`, from the 12.0 MSI's own script that writes it. 35: six files,
// Release 23's eight without the two SelfServiceReporting ones, which the 14.35 installer no longer
// ships (spike 08, docs/spike-08-release-35.md).

import { type FlavorKey } from "./flavors.js";
import { EDIT_LIST_SCHEMA, type Edit, type EditList, parseEditList } from "./edits.js";

const SERVER_CONFIG = "InnovatorServerConfig.xml";

const serverConfig: readonly Edit[] = [
  // One <DB-Connection>; 12.0 and 14.x name the logins dbo_uid/regular_uid, not uid.
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/DB-Connection/@id", value: "{{database}}" },
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/DB-Connection/@database", value: "{{database}}" },
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/DB-Connection/@dbo_uid", value: "{{login.dbo}}" },
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/DB-Connection/@dbo_pwd", value: "{{secret:db_dbo_password}}" },
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/DB-Connection/@regular_uid", value: "{{login.reg}}" },
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/DB-Connection/@regular_pwd", value: "{{secret:db_reg_password}}" },
  // The golden holds no key (ticket 24 blanks it); a key is needed to log in (ticket 09).
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/License/@lic_key", value: "{{secret:licence}}" },
  {
    file: SERVER_CONFIG,
    kind: "xml",
    path: "/Innovator/operating_parameter[@key='temp_folder']/@value",
    value: "{{slotDir}}\\Innovator\\Server\\temp\\",
  },
  {
    file: SERVER_CONFIG,
    kind: "xml",
    path: "/Innovator/operating_parameter[@key='ServerMethodTempDir']/@value",
    value: "{{slotDir}}\\Innovator\\Server\\dll\\",
  },
  {
    file: SERVER_CONFIG,
    kind: "xml",
    path: "/Innovator/operating_parameter[@key='debug_log_prefix']/@value",
    value: "{{slotDir}}\\Innovator\\Server\\logs\\",
  },
  // `http://localhost:8734/` (14.x) or `.../ArasInnovatorAgent` (12.0): only the port changes.
  { file: SERVER_CONFIG, kind: "text", path: "//localhost:{{build.agentPort}}/", value: "//localhost:{{agentPort}}/" },
];

/** Each holds `<ConfigFilePath value="<tree>\InnovatorServerConfig.xml">`: missed, a slot runs on the build's config. */
const configFilePaths: readonly Edit[] = ["Innovator/Client/Innovator.xml", "Innovator/Server/Innovator.xml"].map(
  (file): Edit => ({ file, kind: "xml", path: "/ConfigFilePath/@value", value: "{{slotDir}}\\InnovatorServerConfig.xml" }),
);

const oauthAndVault: readonly Edit[] = [
  // The client's redirect URIs name the alias (20 of them: localhost, the machine names and addresses).
  { file: "OAuthServer/OAuth.config", kind: "text", path: "/{{build.alias}}/", value: "/{{alias}}/", many: true },
  {
    file: "OAuthServer/OAuthServer.config",
    kind: "xml",
    path: "/configuration/appSettings/add[@key='InnovatorServerUrl']/@value",
    value: "{{serverUrl}}",
  },
  {
    file: "VaultServer/vault.config",
    kind: "xml",
    path: "/configuration/appSettings/add[@key='InnovatorServerUrl']/@value",
    value: "{{serverUrl}}",
  },
  // Each slot has its own vault file store.
  {
    file: "VaultServer/vault.config",
    kind: "xml",
    path: "/configuration/appSettings/add[@key='LocalPath']/@value",
    value: "{{vaultDir}}\\",
  },
];

const selfServiceReporting: readonly Edit[] = [
  // The MSI writes `<add connectionString="Data Source=...;Initial Catalog=<db>;...;User ID=<reg login>;Password=<reg password>;" name="<db>" />`.
  {
    file: "SelfServiceReportConfig.xml",
    kind: "xml",
    path: "//add[@connectionString]/@connectionString",
    value:
      "Data Source=(local);Initial Catalog={{database}};Persist Security Info=True;Pooling=False;User ID={{login.reg}};Password={{secret:db_reg_password}};",
  },
  { file: "SelfServiceReportConfig.xml", kind: "xml", path: "//add[@connectionString]/@name", value: "{{database}}" },
  // Its ConfigFilePath names a file in the install directory.
  { file: "SelfServiceReporting/SelfServiceReport.xml", kind: "text", path: "{{build.dir}}\\", value: "{{slotDir}}\\" },
];

const RELEASE_12_AND_14: readonly Edit[] = [...serverConfig, ...selfServiceReporting, ...configFilePaths, ...oauthAndVault];

const EDITS: Readonly<Record<FlavorKey, readonly Edit[]>> = {
  "12sp9": RELEASE_12_AND_14,
  "23": RELEASE_12_AND_14,
  "35": [...serverConfig, ...configFilePaths, ...oauthAndVault],
};

/** The flavor's edit list, validated. */
export function editList(flavor: FlavorKey): EditList {
  return parseEditList({ schema: EDIT_LIST_SCHEMA, flavor, edits: EDITS[flavor] });
}
