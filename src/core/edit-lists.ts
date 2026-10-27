// The per-flavor config edit lists (the engine is edits.ts; docs/edits.md). Data only. The baseline
// builder (ticket 24) writes a flavor's list to `golden\<key>\edits.json`.
//
// 12sp9 and 23: the eight files ticket 09's spike record lists, the same for both (spikes 05 and 07,
// `spike/20-clone-slot.ps1`), with the attribute names read from the spike installs' configs and,
// for `SelfServiceReportConfig.xml`, from the 12.0 MSI's own script that writes it. 35: six files,
// Release 23's eight without the two SelfServiceReporting ones, which the 14.35 installer no longer
// ships (spike 08, docs/spike-08-release-35.md). Ticket 33b adds each release's agent configuration (docs/edits.md): the
// goldens built since carry the agent.

import { type FlavorKey } from "./flavors.js";
import { EDIT_LIST_SCHEMA, type Edit, type EditList, parseEditList } from "./edits.js";

const SERVER_CONFIG = "InnovatorServerConfig.xml";

/**
 * The whole `<License>` element, from the line's one stored licence (ticket 34b). The golden holds no key (ticket 24
 * blanks it); a key is needed to log in (ticket 09), and with it the rest of the element it came with ("License Key is
 * invalid" without them, ticket 24).
 */
const LICENCE_EDITS: readonly Edit[] = [
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/License/@lic_key", value: "{{secret:licence}}" },
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/License/@act_key", value: "{{secret:licence_act_key}}" },
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/License/@lic_type", value: "{{secret:licence_type}}" },
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/License/@company", value: "{{secret:licence_company}}" },
];

const serverConfig: readonly Edit[] = [
  // One <DB-Connection>; 12.0 and 14.x name the logins dbo_uid/regular_uid, not uid.
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/DB-Connection/@id", value: "{{database}}" },
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/DB-Connection/@database", value: "{{database}}" },
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/DB-Connection/@dbo_uid", value: "{{login.dbo}}" },
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/DB-Connection/@dbo_pwd", value: "{{secret:db_dbo_password}}" },
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/DB-Connection/@regular_uid", value: "{{login.reg}}" },
  { file: SERVER_CONFIG, kind: "xml", path: "/Innovator/DB-Connection/@regular_pwd", value: "{{secret:db_reg_password}}" },
  ...LICENCE_EDITS,
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
];

/**
 * Where the server calls the agent and the agent listens: the slot's reserved port, and on 12.0 its alias as the path
 * (names.ts `agentUrl`). The whole value is set, so it does not depend on the build's port or `AS_FOLDER`.
 */
const AGENT_ADDRESS_12 = "http://localhost:{{agentPort}}/{{alias}}";
const AGENT_ADDRESS_14 = "http://localhost:{{agentPort}}/";

const agentAddressIn = (value: string): Edit => ({ file: SERVER_CONFIG, kind: "xml", path: "/Innovator/AgentService/@InnovatorToServiceAddress", value });

/** 12.0: the WCF host's config, as the MSI's XML table writes it (its baseAddress and the server URL). */
const AGENT_CONFIG_12 = "AgentService/Aras.Server.Agent.Service.exe.config";
const agent12: readonly Edit[] = [
  agentAddressIn(AGENT_ADDRESS_12),
  { file: AGENT_CONFIG_12, kind: "xml", path: "/configuration/system.serviceModel/services/service/host/baseAddresses/add/@baseAddress", value: AGENT_ADDRESS_12 },
  { file: AGENT_CONFIG_12, kind: "xml", path: "/configuration/appSettings/add[@key='InnovatorServer']/@value", value: "{{serverUrl}}" },
];

/** 14.x: the Kestrel host's `appsettings.json`, as the MSI's search-and-replace table writes it. */
const AGENT_SETTINGS_14 = "AgentService/appsettings.json";
const agent14: readonly Edit[] = [
  agentAddressIn(AGENT_ADDRESS_14),
  { file: AGENT_SETTINGS_14, kind: "json", path: "/AgentService/InnovatorServerUrl", value: "{{serverUrl}}" },
  { file: AGENT_SETTINGS_14, kind: "json", path: "/Kestrel/Endpoints/HTTP/Url", value: AGENT_ADDRESS_14 },
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

const EDITS: Readonly<Record<FlavorKey, readonly Edit[]>> = {
  "12sp9": [...serverConfig, ...selfServiceReporting, ...configFilePaths, ...oauthAndVault, ...agent12],
  "23": [...serverConfig, ...selfServiceReporting, ...configFilePaths, ...oauthAndVault, ...agent14],
  "35": [...serverConfig, ...configFilePaths, ...oauthAndVault, ...agent14],
};

/** The flavor's edit list, validated. */
export function editList(flavor: FlavorKey): EditList {
  return parseEditList({ schema: EDIT_LIST_SCHEMA, flavor, edits: EDITS[flavor] });
}

/**
 * A golden's list with the whole `<License>` element: a list that sets `lic_key` but not the rest (a golden built before
 * ticket 34b) gets the attributes it lacks, so it renders the element without a rebuild. Any other list is returned as it is.
 */
export function withLicenceElement(list: EditList): EditList {
  const has = (edit: Edit) => list.edits.some((e) => e.file.toLowerCase() === edit.file.toLowerCase() && e.path === edit.path);
  if (!has(LICENCE_EDITS[0]!)) return list;
  const missing = LICENCE_EDITS.filter((edit) => !has(edit));
  return missing.length === 0 ? list : parseEditList({ schema: list.schema, flavor: list.flavor, edits: [...list.edits, ...missing] });
}
