// Sample golden config files for the edit-list tests, written from the structure of the spike installs
// (12sp9 and 23 in spikes 05 and 07, 35 read on 2026-10-27) and the 12.0 MSI's script for
// `SelfServiceReportConfig.xml`: element and attribute names, CRLF line endings, tab indents, the
// quoting each file uses. The agent's configs (ticket 33b) follow the files the MSIs ship, as their
// XML and search-and-replace tables rewrite them for the build's agent. Every value is a placeholder:
// the build's names (ticket 24) and fake passwords, never a real key or password.

import { type FlavorKey } from "./flavors.js";
import { buildNames, buildScratch } from "./names.js";

const crlf = (lines: readonly string[]) => `${lines.join("\r\n")}\r\n`;

/** The build's SQL login passwords as a golden would hold them; the render replaces both. */
export const BUILD_PASSWORDS = { dbo: "build-dbo-placeholder", reg: "build-reg-placeholder" } as const;

/** The machine names that appear in the OAuth client's redirect URIs (placeholders). */
const HOSTS = ["localhost", "EXAMPLEHOST", "EXAMPLEHOST.example.com", "192.0.2.10", "198.51.100.1"];

export function sampleGolden(flavor: FlavorKey): Record<string, string> {
  const b = buildNames(flavor);
  const agentAddress = buildScratch(flavor).agent.address;
  const serverConfig = crlf([
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<Innovator>`,
    `\t<UI-Tailoring product_name="Aras Innovator"/>`,
    `\t<operating_parameter key="debug_log_flag" value="false" />`,
    `\t<operating_parameter key="debug_log_limit" value="5" />`,
    `\t<operating_parameter key="debug_log_pretty" value="true" />`,
    `\t<disabled_operating_parameter key="performance_logging" value="false" />`,
    `\t<operating_parameter key="xslt_processor_debug" value="false" />`,
    `\t<disabled_operating_parameter key="email_debug_option" value="false" />`,
    `\t<License lic_type="Unlimited" lic_key="" act_key="" company="Example"/>`,
    `\t<Mail SMTPServer="queue"/>`,
    `\t<operating_parameter key="temp_folder" value="${b.dir}\\Innovator\\Server\\temp\\" />`,
    `\t<operating_parameter key="ServerMethodTempDir" value="${b.dir}\\Innovator\\Server\\dll\\" />`,
    `\t<operating_parameter key="debug_log_prefix" value="${b.dir}\\Innovator\\Server\\logs\\" />`,
    `\t<AgentService InnovatorToServiceAddress="${agentAddress}"/>`,
    `\t<OAuthServerDiscovery>`,
    `\t\t<Urls>`,
    `\t\t\t<Url value="$[HTTP_PREFIX_SERVER]$[HTTP_HOST_SERVER]$[HTTP_PORT_SERVER]$[HTTP_PATH_SERVER]/OAuthServer/"/>`,
    `\t\t</Urls>`,
    `\t</OAuthServerDiscovery>`,
    `\t<DB-Connection id="${b.database}" database="${b.database}" server="(local)" regular_uid="${b.database}_reg" regular_pwd="${BUILD_PASSWORDS.reg}" dbo_uid="${b.database}_dbo" dbo_pwd="${BUILD_PASSWORDS.dbo}"/>`,
    `</Innovator>`,
  ]);
  const configFilePath = crlf([
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<ConfigFilePath value="${b.dir}\\InnovatorServerConfig.xml"></ConfigFilePath>`,
  ]);
  const redirects = (callbacks: readonly string[]) =>
    HOSTS.flatMap((host) => callbacks.map((cb) => `\t\t\t\t\t<redirectUri value='http://${host}/${b.alias}/Client/OAuth/${cb}' />`));
  const oauth = crlf([
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<oauth>`,
    `\t<server>`,
    `\t\t<tokenSigning><certificate file='App_Data\\Certificates\\OAuth.pfx' /></tokenSigning>`,
    `\t</server>`,
    `\t<clientRegistries>`,
    `\t\t<clientRegistry id='InnovatorClient' enabled='true'>`,
    `\t\t\t<allowedScopes><scope name='Innovator' /></allowedScopes>`,
    `\t\t\t<redirectUris>`,
    ...redirects(["RedirectCallback", "SilentCallback", "PopupCallback"]),
    `\t\t\t</redirectUris>`,
    `\t\t\t<postLogoutRedirectUris>`,
    ...redirects(["PostLogoutCallback"]),
    `\t\t\t</postLogoutRedirectUris>`,
    `\t\t</clientRegistry>`,
    `\t</clientRegistries>`,
    `</oauth>`,
  ]);
  const appSettings = (rows: readonly string[]) => [`\t<appSettings>`, ...rows.map((r) => `\t\t${r}`), `\t</appSettings>`];
  const serverUrl = `<add key="InnovatorServerUrl" value="http://localhost/${b.alias}/Server/InnovatorServer.aspx"></add>`;
  const oauthServer = crlf([
    `<configuration>`,
    `\t<oauth configSource="OAuth.config"></oauth>`,
    ...appSettings([
      serverUrl,
      `<!-- <add key="AuthenticationAdmin" value="admin"></add> -->`,
      `<add key="ProductName" value="Aras Innovator"></add>`,
      `<add key="LogoUrl" value="images/logo.svg"></add>`,
    ]),
    `</configuration>`,
  ]);
  const vault = crlf([
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<configuration>`,
    ...appSettings([
      serverUrl,
      `<add key="LocalPath" value="C:\\aras_installations\\vaults\\build-${flavor}\\"></add>`,
      `<add key="VaultServerName" value="Default"></add>`,
      `<add key="VaultLoginName" value="admin"></add>`,
    ]),
    `\t<oauth configSource="OAuth.config"></oauth>`,
    `</configuration>`,
  ]);
  const files: Record<string, string> = {
    "InnovatorServerConfig.xml": serverConfig,
    "Innovator/Client/Innovator.xml": configFilePath,
    "Innovator/Server/Innovator.xml": configFilePath,
    "OAuthServer/OAuth.config": oauth,
    "OAuthServer/OAuthServer.config": oauthServer,
    "VaultServer/vault.config": vault,
  };
  if (flavor === "12sp9") {
    files["AgentService/Aras.Server.Agent.Service.exe.config"] = crlf([
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<configuration>`,
      `\t<oauth configSource="OAuth.config" />`,
      `\t<appSettings>`,
      `\t\t<add key="InnovatorServer" value="http://localhost/${b.alias}/Server/InnovatorServer.aspx" />`,
      `\t</appSettings>`,
      `\t<system.serviceModel>`,
      `\t\t<services>`,
      `\t\t\t<service name="Aras.Server.Agent.Service.InternalAgent" behaviorConfiguration="basicAuthBehaviour">`,
      `\t\t\t\t<host>`,
      `\t\t\t\t\t<baseAddresses>`,
      `\t\t\t\t\t\t<add baseAddress="${agentAddress}" />`,
      `\t\t\t\t\t</baseAddresses>`,
      `\t\t\t\t</host>`,
      `\t\t\t\t<endpoint address="" binding="basicHttpBinding" bindingConfiguration="basic" contract="Aras.Server.Agent.IInternalAgent" />`,
      `\t\t\t\t<endpoint address="mex" binding="mexHttpBinding" contract="IMetadataExchange" />`,
      `\t\t\t</service>`,
      `\t\t</services>`,
      `\t</system.serviceModel>`,
      `\t<!-- HTTPS enabled -->`,
      `\t<!--system.serviceModel>`,
      `\t\t<services>`,
      `\t\t\t<service name="Aras.Server.Agent.Service.InternalAgent" behaviorConfiguration="basicAuthBehaviour">`,
      `\t\t\t\t<host><baseAddresses><add baseAddress="Https://localhost:8735/ArasInnovatorAgent" /></baseAddresses></host>`,
      `\t\t\t</service>`,
      `\t\t</services>`,
      `\t</system.serviceModel-->`,
      `</configuration>`,
    ]);
  } else {
    files["AgentService/appsettings.json"] = crlf([
      `{`,
      `\t"AgentService": {`,
      `\t\t"InnovatorServerUrl": "http://localhost/${b.alias}/Server/InnovatorServer.aspx"`,
      `\t},`,
      `\t"Kestrel": {`,
      `\t\t"Endpoints": {`,
      `\t\t\t"HTTP": {`,
      `\t\t\t\t"Url": "${agentAddress}"`,
      `\t\t\t}`,
      `\t\t}`,
      `\t},`,
      `\t"LoggerConfiguration": {`,
      `\t\t"MinimumLevel": "Fatal"`,
      `\t}`,
      `}`,
    ]);
  }
  if (flavor !== "35") {
    files["SelfServiceReportConfig.xml"] = crlf([
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<SelfServiceReportConfig>`,
      `\t<connectionStrings>`,
      `\t\t<add connectionString="Data Source=(local);Initial Catalog=${b.database};Persist Security Info=True;Pooling=False;User ID=${b.database}_reg;Password=${BUILD_PASSWORDS.reg};" name="${b.database}" />`,
      `\t</connectionStrings>`,
      `</SelfServiceReportConfig>`,
    ]);
    files["SelfServiceReporting/SelfServiceReport.xml"] = crlf([
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<ConfigFilePath value="${b.dir}\\SelfServiceReportConfig.xml"></ConfigFilePath>`,
    ]);
  }
  return files;
}
