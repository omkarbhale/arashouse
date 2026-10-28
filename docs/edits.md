# The config edit list

A slot's code tree is a mirror of its flavor's golden, and then a few values in a few config files
differ per slot. Ticket 19.

Code: `src/core/edits.ts` (the engine: format, templates, `renderFile`, `verifyFile`),
`src/core/config-text.ts` (the byte-preserving XML and JSON locators and the codec) and
`src/core/edit-lists.ts` (the per-flavor lists). All pure; the caller reads and writes the files
(provisioning, ticket 25; the reset's tree step, ticket 30; the health check, ticket 32).

## `golden\<key>\edits.json`

```json
{
  "schema": 1,
  "flavor": "12sp9",
  "edits": [
    { "file": "InnovatorServerConfig.xml", "kind": "xml", "path": "/Innovator/DB-Connection/@database", "value": "{{database}}" },
    { "file": "OAuthServer/OAuth.config", "kind": "text", "path": "/{{build.alias}}/", "value": "/{{alias}}/", "many": true }
  ]
}
```

The baseline builder (ticket 24) writes it with `serializeEditList(editList(flavor))`; `parseEditList`
validates one.

| field | meaning |
|---|---|
| `file` | relative to the tree root, `/` separated, no `..`; matched case-insensitively, as Windows does (`Innovator.xml` in 12, `innovator.xml` in 14) |
| `kind` | `xml`, `json` or `text` |
| `path` | `xml`: an XPath-style selector; `json`: a JSON Pointer to a string; `text`: the literal text to replace (a template, without secrets) |
| `value` | the value to set (a template) |
| `many` | optional: the selector or text may match more than once, and every match is edited |

**XML selectors** are absolute: `/` a child, `//` any descendant, each step an element name or `*`
with optional `[@name='value']` or `[@name]` predicates, ending in `/@attribute` or `/text()`. An
element without the attribute is not a match.

**Templates** use `{{name}}`. The names, all from `src/core/names.ts`:

| variable | value for `12sp9` slot 1 |
|---|---|
| `alias` | `ah-12sp9-01` |
| `database` | `arashouse_12sp9_01` |
| `login.dbo`, `login.reg` | `arashouse_12sp9_01_dbo`, `_reg` |
| `agentPort` | `8801` |
| `slotDir` | `C:\aras_installations\slots\12sp9\01` |
| `vaultDir` | `C:\aras_installations\vaults\12sp9-01` |
| `serverUrl` | `http://localhost/ah-12sp9-01/Server/InnovatorServer.aspx` |
| `build.alias`, `build.database`, `build.dir` | the names the baseline was installed under (ticket 24): `ah-build-12sp9`, `arashouse_build_12sp9`, `C:\aras_installations\golden-build\12sp9`. The golden's files still hold them. |
| `build.agentPort` | `8734`, the MSI's default `AS_PORT`, which the goldens built before ticket 33b name; only their lists use it. A build since installs its agent on a port of its own, and the list sets the whole agent address instead (below). |

Secret handles may appear in `value` only: `{{secret:licence}}` (a `licence` Secret: the stored key
for the flavor's licence line, from `ensureLicence(flavor, "edit-list", ...)`), `{{secret:licence_act_key}}` (a
`licence` Secret: the `act_key` that goes with the key), `{{secret:db_dbo_password}}`
and `{{secret:db_reg_password}}` (`sql-login` Secrets: the slot's SQL login passwords, ticket 25).
`secretsNeeded(list)` names the handles a list uses. An unknown name or handle is refused when the
list is parsed.

## Rendering

`renderFile(file, goldenBytes, list, editVars(slot), secrets)` applies the list's edits for `file`, in
list order, and returns the new bytes and one outcome per edit:

- **Matches.** A selector, pointer or text that matches nothing is refused (`not-found`), and so is
  one that matches more than once unless the edit says `many` (`ambiguous`).
- **Bytes.** Only the edited value's characters change: encoding (UTF-8 with or without a BOM, UTF-16
  with one), line endings, whitespace, attribute order, quoting and comments survive. XML values are
  escaped for the quote character the attribute already uses. A file that does not decode and
  re-encode to the same bytes is refused (`encoding`); so is malformed XML or JSON (`malformed`).
- **Idempotent.** XML and JSON values are compared decoded: an equal value is `already` and is not
  rewritten. A `text` edit whose text is gone and whose replacement is present is `already`; a
  replacement that contains the text it replaces is refused (`not-idempotent`). Rendering rendered
  bytes returns the same bytes with every edit `already`.
- **Secrets.** A missing secret, or one of the wrong kind, is refused (`secret-missing`) by handle.
  `src/core/edits.ts` is the one place the engine reads a secret's value (`test/reveal-allowlist.test.ts`).
- **The report.** Each outcome is `{ file, kind, path, status: "applied" | "already", matches, value }`,
  where `value` is `[redacted]` for an edit whose template uses a secret. `formatEditOutcomes` gives
  the events-log lines, through `redact`. Error messages name the file, the path and counts, never a
  value.

`verifyFile(file, bytes, list, vars, secrets)` re-reads a rendered file and checks every edit holds:
`ok`, `differs` (with a count, no value) or `error` (the file does not parse, or a secret is
missing). It never throws for the file's content. Ticket 32 runs it after a reset.

## The lists

`12sp9` and `23`: the same eight files and edits (ticket 09's spike record; spikes 05 and 07,
`spike/20-clone-slot.ps1`), and each release's agent configuration (ticket 33b, below):

| file | edits |
|---|---|
| `InnovatorServerConfig.xml` | `<DB-Connection>` `id`, `database`, `dbo_uid`, `dbo_pwd`, `regular_uid`, `regular_pwd`; `<License>` `lic_key`, `act_key`, `lic_type` and `company` (the line's stored licence, `docs/secrets.md`); the `temp_folder`, `ServerMethodTempDir` and `debug_log_prefix` operating parameters (the tree path); `<AgentService InnovatorToServiceAddress>`, the slot's agent address (below) |
| `SelfServiceReportConfig.xml` | the `<add connectionString name>` the MSI writes: database, regular login and its password |
| `Innovator/Client/Innovator.xml`, `Innovator/Server/Innovator.xml` | `<ConfigFilePath value>` |
| `SelfServiceReporting/SelfServiceReport.xml` | the build directory in its `ConfigFilePath` (text) |
| `OAuthServer/OAuth.config` | the alias in the redirect URIs (text, 20 places); the signing certificate's password in `<tokenSigning>` and the OAuth server's own client (`{{secret:oauth_signing_password}}`, ticket 54) |
| `OAuthServer/OAuthServer.config` | `InnovatorServerUrl` |
| `VaultServer/vault.config` | `InnovatorServerUrl`; `LocalPath` (the slot's own vault folder) |

`35`: the same edits less the two SelfServiceReporting files, which the 14.35 installer no longer ships
(spike 08, [`docs/spike-08-release-35.md`](spike-08-release-35.md)).

**The agent (ticket 33b).** A golden built since ticket 33b holds the agent service (`docs/baselines.md`). The slot's
agent listens on the slot's reserved port (`agentPort`) and calls the slot's own server (`serverUrl`); the server
config names the same address. The address is `http://localhost:<agentPort>/<alias>` on 12.0, whose WCF host takes its
path from the MSI's `AS_FOLDER`, and `http://localhost:<agentPort>/` on 14.x (names.ts `agentUrl`). Each value is set
whole, so the list does not depend on the port or `AS_FOLDER` the build used. Found in the MSIs' own tables (the
InstallShield XML table for 12.0, the search-and-replace table for 14.x) and the files they ship:

| flavor | file | edits |
|---|---|---|
| `12sp9` | `AgentService/Aras.Server.Agent.Service.exe.config` | the WCF service's `<host><baseAddresses><add baseAddress>`; `<appSettings><add key="InnovatorServer" value>` |
| `23`, `35` | `AgentService/appsettings.json` | `/Kestrel/Endpoints/HTTP/Url`; `/AgentService/InnovatorServerUrl` |

Neither release's agent names its port or the server anywhere else: its `OAuth.config` (the client certificate, shared
like the other OAuth files), `AgentService.config` (14.x: the OAuth section only), `conversion.config` (processing cycles,
all commented out, naming no URL) and `replication.config` (disabled, placeholders only) are left as shipped. The
conversion server is not installed (`INSTALL_CONVERSION_SERVER=0`), so there is no `ConversionServerConfig.xml`.

Not edited: `ConversionServerConfig.xml` (not installed with the default features); the per-application
`OAuth.config` files, the applications' `appsettings.json` and `InnovatorServer.config` (no slot name in them, spike
07); `<Mail SMTPServer>` (`queue` in the install). The OAuth client certificates are copied with the tree, so all slots
of a flavor share them (design 5.2); the signing certificate is the slot's own, made new at every render with the
password above (`docs/reset.md`).

**Measured, and new against the spike's clone script:** the MSI's script writes the regular login's
password into `SelfServiceReportConfig.xml` as well, which `spike/20-clone-slot.ps1` did not
update; the list sets it. Because it sits in a connection string, the slot's SQL login passwords
(ticket 25) must not contain `;`.

**For the baseline builder (ticket 24):** the text edits find the build's names, so the baseline is
installed under `buildNames(flavor)` (alias, database, directory). The
golden keeps `lic_key`, `act_key`, `dbo_pwd` and `regular_pwd` blank (the build sets them for its own checks and
blanks them before the copy, `docs/baselines.md`). The build's login proof found the key alone refused ("License Key
is invalid"): a slot needs `act_key`, `lic_type` and `company` from the key's source too (spike 30 copied all four),
so the list sets all four from one stored licence through the handles `licence`, `licence_act_key`, `licence_type`
and `licence_company` (ticket 34b). A golden built before that holds an `edits.json` with `lic_key` alone; a render
adds the three attributes it lacks (`withLicenceElement` in `src/core/edit-lists.ts`), so it needs no rebuild.
