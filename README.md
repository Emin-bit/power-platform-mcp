# Power Platform MCP Server

Lokalni MCP (Model Context Protocol) server koji povezuje Claude (Claude Desktop, Claude Code) sa Microsoft Power Platform CLI alatima — `pac` i `pacx`. Tanak omotač: ne reimplementira ništa što PAC već radi, samo prevodi MCP tool pozive u CLI komande, izvršava ih, i vraća rezultat Claudeu.

> **Status: 1.0 — production-ready.** **101 tool** preko svih PAC namespace-a + PACX Tier 1 namespace porodice + job tracking + generički passthrough.

> **Napomena o JSON izlazu:** PAC 2.6 i PACX 1.x **nemaju `--json` flag** (provjereno na pac 2.6.4 / pacx 1.2026.3.195). Sav izlaz je tekst/tabelarni format. Tool-ovi su dizajnirani za to — vraćaju očišćen tekst sa header-om (komanda, exit code, trajanje) koji Claude lako čita. Kad Microsoft doda JSON, prebacujemo se transparentno.

---

## Instalacija (3 koraka, bilo koji OS)

### Korak 1 — Prerequisites + auto-install pac/pacx (jedna komanda)

**Najbrže**: pokreni interaktivni setup wizard. Provjerava obavezne preduslove (Node 18+ i .NET SDK), pa **auto-instalira pac i pacx** preko `dotnet tool install --global` (skipuje ako su već prisutni). Bezbjedno za ponovno pokretanje.

```bash
npx -y @emin-bit/power-platform-mcp setup
```

Setup ima 4 jasne faze:

```
Phase 1 — Mandatory prerequisites (Node.js + .NET SDK)
  ✅ Node.js v22.14.0
  ✅ .NET SDK v10.0.105

Phase 2 — Auto-install pac and pacx (.NET global tools)
  ✓ microsoft.powerapps.cli.tool: newly installed
  ✓ greg.xrm.command: newly installed

Phase 3 — Verify final state (full preflight)
  ✅ node, ✅ dotnet, ✅ pac, ✅ pacx, ⚠️ pac auth (expected — auth dolazi u Phase 4)

Phase 4 — Manual steps (auth + Claude Desktop config)
  1. pac auth create --deviceCode --name myorg
  2. Add config block (printed below)
  3. Restart Claude Desktop
```

**Phase 1 ne može biti auto** — Node.js i .NET SDK zahtijevaju OS-level instalaciju, često sa admin pravima. Setup će ti reći šta da skineš sa kojeg link-a ako fali.

**Manual alternativa** (ako preferiraš svaku komandu eksplicitno):

```bash
# 1. Node.js 18+
#   macOS:   brew install node
#   Windows: winget install OpenJS.NodeJS
#   Linux:   nodejs.org/en/download

# 2. .NET SDK 6+
#   https://dotnet.microsoft.com/download

# 3. PAC + PACX
dotnet tool install --global microsoft.powerapps.cli.tool   # → "pac"
dotnet tool install --global greg.xrm.command                # → "pacx"

# 4. Login (jednom; otvara browser sa device code)
pac auth create --deviceCode --name myorg
```

### Korak 2 — Dodaj MCP u Claude config

**Lokacija config fajla:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

**Sadržaj** (dodaj `power-platform` blok u `mcpServers`):

```json
{
  "mcpServers": {
    "power-platform": {
      "command": "npx",
      "args": ["-y", "@emin-bit/power-platform-mcp"],
      "env": {
        "PAC_MCP_SAFE_MODE": "on",
        "MCP_TIMEOUT": "600000"
      }
    }
  }
}
```

> **Napomena:** prvi put kad Claude Desktop pokrene MCP, `npx` automatski skida paket sa npm-a (5-10 sekundi). Sve sljedeće sesije koriste cache i pokreću se odmah. Update na novu verziju je automatski — `npx` provjerava registry u pozadini.

### Korak 3 — Restart i probaj

Cmd+Q (macOS) ili Ctrl+Q (Win/Linux) Claude Desktop, ponovo ga otvori, novi chat:

```
"Lista mojih PAC auth profila i ko sam ja u Power Platform-u?"
```

Trebao bi vidjeti `whoami` + `auth_list` rezultate. Ako vidiš — radi 🎉. Sad imaš 101 tool dostupan.

---

### Alternativna instalacija (lokalni dev / contributor)

Ako mijenjaš kod ili radiš development:

```bash
git clone https://github.com/Emin-bit/power-platform-mcp.git
cd power-platform-mcp
npm install && npm run build

# Onda u Claude config-u:
"command": "node",
"args": ["/absolute/path/to/power-platform-mcp/dist/index.js"]
```

Vidi [PUBLISHING.md](PUBLISHING.md) za publish workflow.

---

## Šta dobijaš

### Faza 1 — Foundation

| Tool | Opis |
|---|---|
| `whoami` | Aktivni profil, tenant, user, environment — **uvijek pozovi prije destruktivnih operacija** |
| `auth_list` | Listanje svih PAC profila |
| `auth_select` | Prebacivanje aktivnog profila po indeksu |
| `auth_delete` | Brisanje profila (sa `confirm:true`) |
| `auth_create_service_principal` | SP + client secret |
| `auth_create_service_principal_cert` | SP + .pfx certifikat |
| `auth_create_device_code` | Device code flow (vrati URL i kod) |
| `auth_create_interactive` | Interaktivni browser login |
| `pac_help` / `pacx_help` | Help za bilo koju komandu/namespace |
| `pac_run` / `pacx_run` | Generički passthrough — **bilo koja komanda, sadašnja ili buduća** |

### Faza 2 — Environments, Admin, Solutions

**Environment**

| Tool | Opis |
|---|---|
| `env_who` | Detalji aktivne env (user, tenant, base URL) |
| `env_list` | Liste env-a vidljivih korisniku (Global Discovery Service) |
| `env_select` | Postavi default env za aktivni profil |
| `env_list_settings` | Org settings za env, opciono filtrirano |
| `env_fetch` | **FetchXML query** protiv aktivne env (inline ili iz fajla) |

**Admin (read-only — destruktivne admin operacije idu kroz `pac_run` sa `confirm:true` ili Faza 3)**

| Tool | Opis |
|---|---|
| `admin_env_list` | SVI env-i u tenantu (treba admin role) |
| `admin_status` | Status admin operacija u toku (copy/backup/restore/delete) |
| `admin_list_backups` | Backup-i za env |
| `admin_list_tenant_settings` | Tenant-level postavke |
| `admin_list_groups` | Environment grupe |
| `admin_list_app_templates` | Dynamics 365 model-driven app template-i |

**Solution**

| Tool | Opis |
|---|---|
| `solution_list` | Solucije u env-u |
| `solution_online_version` | Get/set verzija solucije u env-u |
| `solution_init` | Novi solution projekat lokalno |
| `solution_pack` / `solution_unpack` | SolutionPackager (lokalno) |
| `solution_version` | Update verzije u local solution.xml |
| `solution_create_settings` | Generiši deployment settings .json template |
| `solution_export` | Export iz env-a u .zip (long-running, async) |
| `solution_clone` | Export + unpack u jednom koraku |
| `solution_publish` | Publish customizations (live env) |
| `solution_check` | Solution Checker analiza (long-running, vraća SARIF) |

### Faza 3 — Long-running operations + Job tracking

**Long-running operacije.** Svaka ima `background: true` opciju za fire-and-forget i tip `confirm: true` za destruktivne (gdje primjenjivo).

| Tool | Opis | Destruktivno |
|---|---|---|
| `solution_import` | Import .zip u env, sa svim flag-ovima (force_overwrite, settings_file, stage_and_upgrade, ...) | ✅ |
| `solution_upgrade` | Apply pending holding-solution upgrade | ✅ |
| `env_create` | Kreiraj novi env u tenantu (cost!) | ⚠️ confirm |
| `env_copy` | Copy source → target env (target overwritten) | ✅ |
| `env_backup` | Manualni backup env-a | — |
| `env_restore` | Restore env iz backup-a | ✅ |
| `env_delete` | Briši env iz tenanta (irreverzibilno) | ✅ |
| `env_reset` | Wipe env data + customizations | ✅ |

**Job tracking.** Kad pokreneš tool sa `background: true`, MCP server spawn-uje `pac` proces i vraća ti `job_id` odmah. Pratiš ga kroz:

| Tool | Opis |
|---|---|
| `job_list` | Lista svih jobs u sesiji (running/succeeded/failed/cancelled) |
| `job_status` | Detalji jednog job-a + buffer izlaza (do 200KB po stream-u) |
| `job_wait` | Blokiraj dok se job ne završi (ili timeout) |
| `job_cancel` | Pošalji SIGTERM (pa SIGKILL nakon 5s) lokalnom pac procesu |

> **Bitno o cancel-u:** `job_cancel` ubija samo lokalni `pac` proces. **Server-side operacija u Power Platform-u nastavlja.** Za realan server-side status koristi `admin_status`.
>
> **Bitno o trajanju:** jobs žive samo dok je MCP server živ. Quit Claude Desktop = jobs umiru. (Server-side operacija opet nastavlja.)

### Faza 4 — Domain tools (canvas, pages, pcf, plugin, connection, connector, application, modelbuilder, telemetry)

**Canvas Apps**

| Tool | Opis |
|---|---|
| `canvas_list` | Lista canvas app-ova u env-u |
| `canvas_download` | Download .msapp (može auto-extract) |
| `canvas_pack` | (Preview) Pack source folder → .msapp |
| `canvas_unpack` | (Preview) Unpack .msapp → source folder |
| `canvas_create` | Generiši canvas app iz custom connector-a |

**Power Pages**

| Tool | Opis |
|---|---|
| `pages_list` | Lista Power Pages site-ova |
| `pages_download` | Download site content lokalno |
| `pages_upload` | Upload na live site (DESTRUKTIVNO, traži `confirm:true`) |
| `pages_clone` | Lokalna kopija site content-a |

**PCF (Power Apps Component Framework)**

| Tool | Opis |
|---|---|
| `pcf_init` | Init novi PCF projekat lokalno |
| `pcf_push` | Build + push u env (DESTRUKTIVNO, `confirm:true`) |
| `pcf_version` | Bump patch verzije ControlManifest.xml |

**Plugins**

| Tool | Opis |
|---|---|
| `plugin_init` | Init novi plug-in class library lokalno |
| `plugin_push` | Push assembly/NuGet u env (DESTRUKTIVNO, `confirm:true`) |

**Connections** (sa SP credential masking)

| Tool | Opis |
|---|---|
| `connection_list` | Lista connection-a |
| `connection_create` | Novi connection bound za SP (secret se redact-uje) |
| `connection_update` | Rotacija SP credential-a |
| `connection_delete` | Briši connection (DESTRUKTIVNO, `confirm:true`) |

**Custom Connectors**

| Tool | Opis |
|---|---|
| `connector_list` | Lista connector-a |
| `connector_init` | Scaffold API Properties fajla |
| `connector_create` | Kreiraj novi connector u env-u iz lokalnih fajlova |
| `connector_download` | Download OpenAPI definicije + API Properties lokalno |
| `connector_update` | Update postojećeg connector-a |

**Marketplace Applications**

| Tool | Opis |
|---|---|
| `application_list` | Lista Dataverse app-ova iz Microsoft Marketplace |
| `application_install` | Instaliraj/update app u env (`confirm:true`) |

**Code Generation**

| Tool | Opis |
|---|---|
| `modelbuilder_build` | Generiši C#/VB code (entities, messages, optionsets) iz Dataverse metadate |

**Telemetry**

| Tool | Opis |
|---|---|
| `telemetry_status` / `telemetry_enable` / `telemetry_disable` | PAC CLI telemetry opt-in (lokalna postavka) |

### Faza 5 — PACX namespace porodica (Tier 1)

PACX (Greg.Xrm.Command Extended) je nezavisan alat sa **vlastitom auth shemom** odvojenom od PAC-a. PACX nudi operacije koje PAC ne pokriva direktno (kreiranje tabela/kolona, batch workflow operacije, default-solution koncept). Eksplicitno mapirano u Tier 1; ostali PACX namespace-i (optionset, key, rel, view, settings, forms, ribbon, webresources, unifiedrouting, project, script, tool, org, plugin) ostaju pristupačni preko `pacx_run`.

**PACX Auth (vlastite profile, odvojene od `pac auth`)**

| Tool | Opis |
|---|---|
| `pacx_auth_list` | Lista PACX profila |
| `pacx_auth_create` | OAuth interactive / SP secret / connection string |
| `pacx_auth_select` | Postavi aktivni PACX profil |
| `pacx_auth_delete` | Briši profil (`confirm:true`) |
| `pacx_auth_rename` | Preimenuj profil |
| `pacx_auth_ping` | Test konekcije sa aktivnim profilom |

**PACX Solution (sa default-solution konceptom)**

| Tool | Opis |
|---|---|
| `pacx_solution_list` | Lista solucija (filter po type/hidden) |
| `pacx_solution_create` | Kreiraj unmanaged solution + publisher u jednom koraku |
| `pacx_solution_delete` | Briši solution (`confirm:true`) |
| `pacx_solution_get_default` | Get PACX-ov "default solution" |
| `pacx_solution_set_default` | Postavi default solution (subseq. table/column ops ga koriste) |
| `pacx_solution_get_publishers` | Lista publisher-a sa prefix-ima |

**PACX Table (popunjava major PAC gap)**

| Tool | Opis |
|---|---|
| `pacx_table_create` | Kreiraj tabelu — sve metadata flag-ovi (ownership, audit, activity, queue, feedback, notes, change tracking, primary attr autonumber) |
| `pacx_table_update` | Update metadata postojeće tabele |
| `pacx_table_delete` | Briši tabelu (`confirm:true`) |
| `pacx_table_print` | Mermaid classDiagram za tabele u solution-u (dokumentacija) |
| `pacx_table_export_metadata` | Export metadata (Json/Excel) za tabelu |

**PACX Column (popunjava major PAC gap)**

| Tool | Opis |
|---|---|
| `pacx_column_add` | Dodaj kolonu sa `type` discriminator-om (boolean / datetime / decimal / double / file / image / integer / memo / money / optionset / string) — type-specifični flag-ovi se kondicionalno prosljeđuju |
| `pacx_column_delete` | Briši kolonu (`confirm:true`) |
| `pacx_column_export_metadata` | Export metadata kolone |

**PACX Misc**

| Tool | Opis |
|---|---|
| `pacx_publish_all` | Publish customizations (PACX equivalent solution_publish) |
| `pacx_history_get` / `pacx_history_clear` / `pacx_history_set_length` | PACX command history |
| `pacx_workflow_list` | Lista flows / workflows / business rules / BPF / desktop flows / AI flows (sa kategorijom filter-om) |
| `pacx_workflow_activate` / `pacx_workflow_deactivate` | Batch activate/deactivate flows |

Generički `pac_run` / `pacx_run` znače da već **sad** možeš raditi sve što PAC/PACX podržavaju — Claude koristi `pac_help` da otkrije šta postoji, pa zove `pac_run` da izvrši (uz safe-mode gate za destruktivne).

---

## Quickstart workflows — šta da pitaš Claudea

Sve dolje su prirodno-jezični prompti; Claude ih mapira na konkretne tool pozive automatski.

### Discovery i kontekst (prvi koraci u svakoj sesiji)

```
"Ko sam ja u Power Platform-u i u kom env-u sam?"
   → whoami + env_who

"Lista svih mojih PAC profila"
   → auth_list

"Šta sve postoji od pac komandi za rad sa solution-ima?"
   → pac_help path="solution"

"Lista svih env-a u tenantu"
   → admin_env_list
```

### Solution lifecycle (dev → test → prod)

```
"Lista svih solucija u trenutnom env-u"
   → solution_list

"Export-uj 'MyAppSolution' kao managed .zip u ~/exports/"
   → solution_export name="MyAppSolution" path="~/exports/MyAppSolution_managed.zip" managed=true

"Unpack tu .zip u ~/source/MyAppSolution/"
   → solution_unpack zipfile="~/exports/MyAppSolution_managed.zip" folder="~/source/MyAppSolution"

"Import-uj solution-of-records.zip u dev env, sa publish-om i activate-om plugin-a"
   → solution_import path="..." publish_changes=true activate_plugins=true confirm=true

"Pokreni Solution Checker analizu"
   → solution_check path="~/exports/MyAppSolution.zip" output_directory="~/checker-results"
```

### Environments & backups

```
"Napravi manualni backup aktivnog env-a sa label-om 'before-deploy-Q2'"
   → env_backup label="before-deploy-Q2"

"Lista backup-a"
   → admin_list_backups

"Restore env iz najnovijeg backup-a"
   → env_restore source_environment="..." selected_backup="latest" confirm=true

"Kopiraj prod env u sandbox kao FullCopy, u background-u"
   → env_copy source_environment="..." target_environment="..." type="FullCopy" background=true confirm=true
   → onda: job_status id=<id>
```

### Dataverse query (FetchXML)

```
"Pokreni FetchXML query koji vraća top 5 accounts po revenue"
   → env_fetch xml="<fetch top='5'>...</fetch>"
```

### Canvas Apps / Power Pages

```
"Lista canvas app-ova"
   → canvas_list

"Download 'PSAE Code App' u .msapp file u ~/canvas/"
   → canvas_download name="PSAE Code App" extract_to_directory="~/canvas/psae"

"Lista Power Pages site-ova"
   → pages_list

"Download site sadržaj sa ID-em <guid> u ~/pages/site1"
   → pages_download path="~/pages/site1" website_id="<guid>"
```

### PCF + Plugins

```
"Init novi PCF projekat tipa 'field' sa React-om u ~/pcf/MyControl"
   → pcf_init namespace="MyCorp" name="MyControl" template="field" framework="react" output_directory="~/pcf/MyControl"

"Push PCF projekat u env"
   → pcf_push solution_unique_name="MyAppSolution" confirm=true

"Init plugin projekat u ~/plugins/MyPlugin"
   → plugin_init output_directory="~/plugins/MyPlugin" author="My Team"
```

### Code generation iz Dataverse metadate

```
"Generiši C# entity klase za sve account/contact tabele u ~/Generated/"
   → modelbuilder_build out_directory="~/Generated" namespace="MyApp.Dataverse" entity_names_filter="account;contact"
```

### PACX — table & column ops (popunjava major PAC gap)

```
"Napravi novu tabelu 'Project' sa custom autonumber primary key 'PRJ-{SEQNUM:5}'"
   → pacx_table_create name="Project" plural="Projects"
        primary_attribute_name="Code"
        primary_attribute_autonumber_format="PRJ-{SEQNUM:5}"
        notes=true audit=true

"Dodaj string kolonu 'Description' (max 500 chars, RichText format) u tabelu cr123_project"
   → pacx_column_add type="string" table="cr123_project" name="Description"
        length=500 string_format="RichText"

"Dodaj choice kolonu 'Status' sa opcijama 'Active:1,Onhold:2,Done:3'"
   → pacx_column_add type="optionset" table="cr123_project" name="Status" options="Active:1,Onhold:2,Done:3"

"Publish-uj sve customizacije"
   → pacx_publish_all

"Generiši Mermaid diagram tabela u 'MyAppSolution'"
   → pacx_table_print solution="MyAppSolution"
```

### Long-running ops sa background tracking-om

```
"Pokreni solution_import u background-u i daj mi job ID"
   → solution_import path="..." background=true confirm=true
   → vrati: "Started background job. id=ab12cd34..."

"Status job-a ab12cd34"
   → job_status id="ab12cd34"

"Lista svih background job-ova u ovoj sesiji"
   → job_list

"Čekaj da se import završi"
   → job_wait id="ab12cd34" timeout_seconds=1800

"Otkaži job"
   → job_cancel id="ab12cd34"
```

### Escape hatch — passthrough za sve ostalo

```
"Pokreni: pac catalog list"
   → pac_run args="catalog list"

"Pokreni: pacx optionset list"
   → pacx_run args="optionset list"
```

---

## Preduvjeti

- **Node.js ≥ 18** (provjeri sa `node --version`)
- **Power Platform CLI** instaliran kao .NET global tool:
  ```bash
  dotnet tool install --global Microsoft.PowerApps.CLI.Tool
  ```
  Provjeri sa `pac --version`. Ako `pac` nije u PATH-u, MCP server automatski dodaje uobičajene lokacije (`~/.dotnet/tools`, `/usr/local/share/dotnet`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` na Unixu; `%USERPROFILE%\.dotnet\tools`, `%LOCALAPPDATA%\Microsoft\PowerAppsCli` na Windows-u).

- **PACX** (Power Platform CLI Extensions): instalira se odvojeno od PAC-a, kao posebni `dotnet tool`. Provjeri sa `pacx --version`.

---

## Instalacija (lokalni dev)

```bash
cd "/Users/eminmujabasic/Desktop/MCP za PowerPlatform"
npm install
npm run build
```

Build proizvodi `dist/index.js` sa shebang-om i izvršnim bitom — možeš ga pokrenuti direktno:

```bash
node dist/index.js
# ili
./dist/index.js
```

Server komunicira preko stdio — bez Claude klijenta neće raditi ništa korisno (samo čeka MCP poruke).

---

## Konfiguracija u Claude klijentu

### Claude Desktop (macOS)

Edituj `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "power-platform": {
      "command": "node",
      "args": ["/Users/eminmujabasic/Desktop/MCP za PowerPlatform/dist/index.js"],
      "env": {
        "PAC_MCP_SAFE_MODE": "on"
      }
    }
  }
}
```

> **macOS PATH napomena**: Claude Desktop ne učitava `~/.zshrc` ili `~/.bash_profile`, pa `pac` instaliran preko `dotnet tool` ne bi bio vidljiv. MCP server **sam dodaje** `~/.dotnet/tools` u PATH za child procese, tako da to obično radi out-of-the-box. Ako i dalje ne pronađe `pac`, postavi `PAC_BIN_PATH` na apsolutnu putanju:
>
> ```json
> "env": {
>   "PAC_BIN_PATH": "/Users/eminmujabasic/.dotnet/tools/pac",
>   "PACX_BIN_PATH": "/Users/eminmujabasic/.dotnet/tools/pacx"
> }
> ```

Restartuj Claude Desktop nakon izmjene.

### Claude Code (CLI)

```bash
claude mcp add power-platform -- node "/Users/eminmujabasic/Desktop/MCP za PowerPlatform/dist/index.js"
```

Provjeri sa `claude mcp list`.

### Windows (Claude Desktop)

`%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "power-platform": {
      "command": "node",
      "args": ["C:\\Users\\YOU\\Desktop\\MCP za PowerPlatform\\dist\\index.js"],
      "env": { "PAC_MCP_SAFE_MODE": "on" }
    }
  }
}
```

---

## Environment varijable

| Varijabla | Default | Opis |
|---|---|---|
| `PAC_MCP_SAFE_MODE` | `on` | `on`/`off` — destruktivne komande traže `confirm:true` kad je on |
| `PAC_MCP_VERBOSE` | `off` | `1`/`true` — verbose logovi na stderr |
| `PAC_MCP_LOG_DIR` | `~/.power-platform-mcp/logs` | Lokacija dnevnih log fajlova |
| `PAC_BIN_PATH` | (auto) | Apsolutna putanja do `pac` binary-ja (override) |
| `PACX_BIN_PATH` | (auto) | Apsolutna putanja do `pacx` binary-ja (override) |

---

## Sigurnost — destruktivne operacije

Sa **safe-mode = on** (default), MCP odbija sljedeće dok ne dobije eksplicitan `confirm: true`:

- Bilo koji subverb iz: `delete`, `delete-environment`, `delete-tenant-settings`, `reset`, `restore`, `wipe`, `remove`, `destroy`, `uninstall`
- Specifične opasne komande: `admin copy`, `env copy`, `solution import`, `solution upgrade`, `solution apply-upgrade`, `solution clone-and-merge`, `package deploy`, `pipeline deploy`, `data import`
- Bilo koja komanda sa `--force` / `--overwrite` / `--force-overwrite`

Prije nego što potvrdiš destruktivnu operaciju, pozovi `whoami` da vidiš na kojem si tenantu i environmentu.

Secret-i (`--clientSecret`, `--password`, `--certificatePassword` i njihovi aliasi) **nikad se ne logiraju u plain text** — maskiraju se kao `***REDACTED***` u logu i u izlazu vraćenom Claudeu.

---

## Logovi

Lokacija: `~/.power-platform-mcp/logs/pac-mcp-YYYY-MM-DD.log` (jedan fajl po danu, JSON Lines format).

Svaki red je jedan event: timestamp, level, poruka, polja (komanda, exit code, trajanje, itd). Secret-i su maskirani.

```bash
tail -f ~/.power-platform-mcp/logs/pac-mcp-$(date +%Y-%m-%d).log | jq .
```

---

## Šta MCP NE radi (svjesno izvan opsega)

- Direktni Dataverse Web API pozivi (drugi MCP)
- Power BI (drugi CLI)
- Microsoft Graph (Entra app management — koristi zaseban alat ili Azure CLI)
- Bilo kakva poslovna logika iznad PAC-a — sva inteligencija je u Claudeu

---

## Roadmap

- **Faza 1 (gotovo)**: passthrough, help, auth, safe-mode, logovanje
- **Faza 2 (gotovo)**: tipovani wrapper tool-ovi za env, admin (read), solution. JSON parsiranje preskočeno jer PAC nema `--json` flag.
- **Faza 3 (gotovo)**: long-running tool-ovi (solution_import/upgrade, env_create/copy/backup/restore/delete/reset) sa `background: true` opcijom, plus 4 generic job-tracking tool-a. `pac package deploy` ne postoji u PAC 2.6 pa je preskočen.
- **Faza 4 (gotovo)**: 29 domain tool-ova preko canvas/pages/pcf/plugin/connection/connector/application/modelbuilder/telemetry namespace-a.
- **Faza 5 (gotovo)**: 27 PACX Tier 1 tool-ova (auth, solution, table, column, publish, history, workflow). Tier 2/3 PACX (optionset, key, rel, view, settings, forms, ribbon, webresources, unifiedrouting, project, script, tool, org, plugin) pristupačni preko `pacx_run`.
- **Faza 6**: dokumentacija sa primjerima per-tool, npm publish, verifikacija na svežem Mac/Windows/Linux setup-u

---

## Troubleshooting

### MCP se ne pojavljuje u Claude Desktop-u nakon edit-a config-a

Najčešći razlog: **Claude Desktop nije stvarno restartovan**. Zatvaranje prozora (Cmd+W ili klik X) ne gasi aplikaciju.

```bash
# Verifikuj
ps aux | grep "Claude.app" | grep -v grep

# Ako je još pokrenut, ugasi
pkill -f "Claude.app"
```

Onda otvori Claude.app ponovo i provjeri MCP indikator (plug ikonica).

### Config se prebrisao, izgubio sam moj entry

**Uzrok:** otvaranje **Settings UI** u Claude Desktop-u (sidebar mode toggle, theme change, itd.) — Claude Desktop sačuva config iz svoje in-memory verzije, prebrišući entry-je koji su dodani na disk poslije njegovog start-a.

**Rješenje:** uredi config **prije** nego što otvoriš Settings UI. Procedura:
1. Quit Claude Desktop (Cmd+Q ili `pkill -f "Claude.app"`).
2. Edit `~/Library/Application Support/Claude/claude_desktop_config.json` u text editor-u.
3. Otvori Claude Desktop.
4. **Ne diraj Settings UI** dok ne potvrdiš da MCP radi.

### macOS Keychain popup "pac želi pristupiti ključu powerplatform_cli_service"

PAC čuva OAuth tokene u Keychain-u. Kad ga Claude Desktop spawn-uje (drugačiji proces context od Terminala), macOS pita za odobrenje.

**Najbrže rješenje:** klikni **"Uvijek dozvoli"** (ne "Dozvoli"!) i unesi password Mac-a. Ovo dodaje `pac` u ACL listu Keychain entry-ja zauvijek (osim ako se reinstalira).

**Pedantnije:** otvori Keychain Access → traži `powerplatform` → za svaki entry → Access Control tab → dodaj `/Users/<you>/.dotnet/tools/pac` u "Always allow access by these applications" listu.

**Šta NE raditi:** "Allow all applications" — bilo koji program može čitati tvoje Power Platform tokene.

### `pac: command not found` u MCP server logu

Claude Desktop spawn-uje child procese sa minimalnim PATH-om. MCP automatski dodaje uobičajene `pac` lokacije u PATH (`~/.dotnet/tools`, `/opt/homebrew/bin`, `/usr/local/bin`, ...), ali ako pac nije nigdje od toga, eksplicitno postavi:

```json
"env": {
  "PAC_BIN_PATH": "/absolute/path/to/pac",
  "PACX_BIN_PATH": "/absolute/path/to/pacx"
}
```

### Server se starta ali Claude ne vidi tool-ove

1. `npm run build` pokrenut, `dist/index.js` postoji?
2. Putanja u Claude config-u apsolutna i tačna (uključujući space-ove ako ih ima)?
3. JSON valid? `python3 -m json.tool < ~/Library/Application\ Support/Claude/claude_desktop_config.json > /dev/null`
4. Pogledaj log: `tail -f ~/Library/Logs/Claude/mcp-server-power-platform.log`

### Komanda otkaže oko 60 sekundi (Claude Desktop transport timeout)

Postoje **dva nivoa timeout-a**, što je važno razumjeti:

1. **Server-side timeout** (kontrolisan ovim MCP-om) — defaultno 60s do 30min po tool-u, override-uje se kroz parametre tool-a (`timeout_seconds`, `max_wait_minutes`).
2. **MCP transport timeout** (kontrolisan **Claude Desktop-om**) — defaultno **~60 sekundi**. Ako tvoj alat radi duže od ovoga, Claude Desktop ga otkazuje sa svoje strane bez obzira što server još radi.

Ovo je čest problem za PACX `table create`, `column add`, `publish all`, kao i large `solution_pack`/`unpack` koje često traju 1-3 minute.

**Dva fix-a (oba se preporučuju zajedno):**

#### Fix 1 — Podigni MCP transport timeout u Claude Desktop config-u

```json
{
  "mcpServers": {
    "power-platform": {
      "command": "node",
      "args": ["..."],
      "env": {
        "PAC_MCP_SAFE_MODE": "on",
        "MCP_TIMEOUT": "600000"
      }
    }
  }
}
```

`MCP_TIMEOUT` je u milisekundama; `600000` = 10 minuta. Ovo Claude Desktop respektuje.

#### Fix 2 — Koristi `background: true` na long-running tool-ovima

Većina tool-ova koji mogu preći 60s ima `background: true` parametar. Tool odmah vraća `job_id`, ne blokira na MCP transport-u, pa nema 60s wall-a:

```
"Kreiraj tabelu 'Project' u background-u"
   → pacx_table_create name="Project" background=true
   → vrati: "Started background job. id=ab12cd34..."

"Status job-a"
   → job_status id="ab12cd34"
```

Tool-ovi sa `background: true` (od 1.0.2): `pac_run`, `pacx_run`, `pacx_table_create/update/delete`, `pacx_column_add/delete`, `pacx_solution_create/delete`, `pacx_publish_all`, `pacx_workflow_activate/deactivate`, plus svi Phase 2/3 long-running tool-ovi (`solution_export/import/upgrade/clone/publish/check/pack/unpack`, `env_create/copy/restore/delete/reset`).

**Bitno**: čak i sa `MCP_TIMEOUT=600000`, neke komande (long-running solution import, env copy/restore) i dalje treba pokretati u `background:true` — koriste se sa `job_status` da vidiš real-time progress umjesto da čekaš mute 10 minuta.

### Server-side operacija nastavlja nakon job_cancel

To je očekivano. `job_cancel` ubija samo lokalni `pac` proces. Power Platform server-side operacija (npr. solution import, env copy) je već submit-ovana i nastavlja na backend-u. Provjeri stvarno stanje sa:

```
"Status admin operacija u tenantu" → admin_status
```

### Tool koji mi treba ne postoji eksplicitno

Koristi passthrough — uvijek radi:
```
"Pokreni: pac <namespace> <subcommand> --flag value"
   → pac_run args="..."
```

Ili ako ne znaš sintaksu:
```
"Help za pac <namespace>" → pac_help path="<namespace>"
```

### Žellim vidjeti tačno šta MCP šalje PAC-u

Postavi `PAC_MCP_VERBOSE=1` u Claude config-u i prati log:
```bash
tail -f ~/.power-platform-mcp/logs/pac-mcp-$(date +%Y-%m-%d).log | jq .
```

Vidjećeš svaku komandu (sa maskiranim secret-ima), exit code, trajanje. Polovina debugging-a se rješava ovdje.

### Smoke test za ručni sanity-check

Bez Claude-a, direktno preko stdin-a:
```bash
cd "/path/to/MCP za PowerPlatform"
npm test
# OK initialize / OK tools/list / OK pac_help (output 2.7KB) / OK safe-mode block / OK confirm gate / ALL SMOKE TESTS PASSED
```
