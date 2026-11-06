# Modules

Every DAO has the same core: a Governor (`HomebaseDAO`), a `TimelockController`, a `Registry` and a non-transferable `RepToken`. Everything else is a module: the Economy, the Autonet layer, the ContentCourt. A DAO picks modules at origination and can add or remove them later by proposal.

The design follows [Aragon OSx plugins](https://docs.aragon.org/osx-contracts/1.x/framework/plugin-repos/): setups that prepare installations, versioned repos, a registry of repos, and release and build metadata that apps render setup forms from. It is adapted to an OpenZeppelin core, where rights live on the token and the Registry instead of in a DAO permission manager, and the timelock executes attach actions itself instead of a setup processor.

## Contracts

| Contract | Aragon OSx | Role |
|---|---|---|
| `IModuleSetup`, `ModuleSetup` | `PluginSetup` | Prepares installations of one module. |
| `ModuleRepo` | `PluginRepo` | One module's versions, tagged `RELEASE.BUILD`, with metadata URIs. The maintainer (owner) publishes. |
| `ModuleCatalog` | `PluginRepoRegistry` | The modules a network offers, one repo per module name. The curator (owner) registers and removes repos. |
| `ModuleProcessor` | `PluginSetupProcessor` | Checks installations and builds the attach and detach proposal actions. Holds no state and no rights. |
| `JurisdictionFactory` | `DAOFactory` | Creates the core and attaches modules at origination. |

## Installing a module

1. **Prepare.** Anyone calls `setup.prepareInstallation(core, data)` with the DAO's `Core { registry, timelock, token, governor }`. It deploys the module's contracts wired to that core and returns an installation id (also `lastPreparedBy(preparer)`). `data` is the ABI encoding of the inputs in the version's build metadata. A prepared installation has no rights.
2. **Attach.** `setup.installationOf(id)` returns the `Prepared` installation: the module's main contract, its helpers, the `install` and `uninstall` actions (RepToken grants such as `setMinter` and `setSlasher`), its Registry entries, and its dependencies. Attaching executes `install` and records the entries. Every installation's entries include `modules.<name>` = `"<setup>:<id>"`, so a DAO's attached modules can be read from its Registry.

Attaching happens at one of two points:

- **At origination.** `JurisdictionFactory.deployCore(params)` creates the core with the factory as token admin and Registry owner. The founder prepares each module for that core, then calls `finalize(core, modules, keys, values)`. That attaches the modules in order and hands everything to the timelock. The factory executes a module's actions only against that DAO's own token and Registry (`ForeignTarget` otherwise). Only the account that deployed a core can finalize it. A DAO with no modules is one call: `deploy(params, keys, values)`.
- **After origination.** A member prepares the installation and proposes `ModuleProcessor.installCalls(setup, id)`. `uninstallCalls(setup, id)` builds the reverse proposal: it revokes the grants and clears the entries. The proposal lists every grant, so voters see exactly what they approve. Preparing grants nothing; the grants and entries are all in the proposal's calldata. A proposal that grants or revokes token rights, approves an option source or writes the Autonet charter is constitutional and needs the DAO's supermajority ([governance.md](governance.md)), so attaching or detaching the Economy, the content court or Autonet always does.

Both paths apply the same checks (`ModuleProcessor.checkInstall`):

- The setup is a published version in the catalog (`NotPublished`).
- The installation was prepared for this core (`WrongCore`). After origination, the core must also be a live jurisdiction whose Registry, Timelock, token and Governor point at each other (`NotAJurisdiction`).
- No installation of the same module is attached (`AlreadyAttached`).
- Every dependency is attached at the address the installation was wired to (`MissingDependency`). At origination, modules attach in order, so dependencies come first.

Detaching is refused while an attached module depends on the one being removed (`HasDependents`). No published module depends on another today; the mechanism is there for future modules (`test/modules.test.js` covers it with a test-only module). The Registry lists a cleared key once, so a module can be detached and attached again.

## Modules

| Module | Setup | `data` | Grants | Depends on | Registry entries |
|---|---|---|---|---|---|
| `economy` | `EconomySetup` | `EconomySetup.Params` | `EconomyRepClaim` (minter) | none | `jurisdiction.economy`, `jurisdiction.economy.rep_claim` |
| `content_court` | `ContentCourtSetup` | `ContentCourt.Params` | court (slasher) | none | `jurisdiction.content_court.court` ([content-court.md](content-court.md)) |
| `autonet` | `AutonetSetup` | `(AutonetParams, ToolBond.Params)` | REP claim (minter), ToolBond (slasher), AnchorElection (governor option source) | none | `jurisdiction.autonet.*` ([autonet.md](autonet.md#genesis-autonetsetup)) |

The Economy module deploys an `Economy`, configures it, and hands it to the timelock in the same transaction. Its `EconomyRepClaim` mints REP for what members earn and spend in it, at the jurisdiction's parities. RepToken knows nothing about any Economy: reputation comes only from minters the DAO grants and revokes.

## Metadata

Each module's metadata lives in `modules/<name>/` and is published with each version as a `data:application/json;base64,` URI, so no external host is needed. It follows Aragon's format:

- `release-metadata.json`: `{ name, description, images }`.
- `build-metadata.json`: `{ ui, change, pluginSetup: { prepareInstallation: { description, inputs }, prepareUpdate, prepareUninstallation } }`. `inputs` is Solidity JSON ABI with a `description` per element, in the order the setup decodes `data`.

Two extensions, both ignored by anything that only reads Aragon's fields:

- `ui.requires` lists the modules this one depends on (empty for every published module).
- Each input may carry `x-ui` hints for form rendering: `label`, `section`, `default`, `min`, `max`, and `unit`. Units are `bps-percent` (entered as a percent, encoded times 100), `seconds-days`, `seconds-hours`, `seconds-duration` (days, hours and minutes fields; `default`, `min` and `max` in seconds), `decimals:<n>` (a decimal amount in base units), and `bytes32-optional` (empty encodes as zero). `fixed` encodes a constant without showing a field, and `source: "module:<name>"` fills an address with that attached module's main contract. `immutable: true` marks a value the module can't change after creation (the form says so); no published module uses it now, so the DAO can change every value by proposal. `minFrom: "<view>"` reads `min` from a no-argument uint view on the setup, for minimums fixed per deployment such as the Economy's `minCoolingOffPeriod`.

`scripts/lib/modules.js` `encodeInstallData(name, values)` encodes `data` from the metadata. The tests prepare every module through it, so the metadata and the setups can't drift apart.

## Publishing a new module or version

1. Write a setup that extends `ModuleSetup`, with `moduleName()`, `_prepare` (decode `data`, deploy, return the main contract) and `_describe` (actions, entries, dependencies). The helpers `_repGrants`, `_entries` and `_dependsOn` cover the usual cases.
2. Write `modules/<name>/release-metadata.json` and `build-metadata.json`.
3. Deploy the setup. Deploy a `ModuleRepo(name, maintainer)` and call `createVersion(1, setup, buildMetadata, releaseMetadata)`, then have the curator `register` the repo in the catalog. For a new version of an existing module, only `createVersion` is needed: a new build for compatible changes, a new release for breaking ones. `MODULE=<name> CATALOG=<addr> npx hardhat run scripts/publish-module-build.js --network <net>` publishes a new build of a module in its latest release: it deploys a fresh setup (for `economy`, with the previous build's implementations and `minCoolingOffPeriod`) and publishes it with the current `modules/<name>/` metadata. The signer must own the repo.

Apps list modules from the catalog, so neither step needs an app release.

## Trust

Attaching grants whatever a setup's installation lists, so the catalog is the trust root: JurisdictionFactory and ModuleProcessor accept only setups published in it. The curator and each repo's maintainer are the deployer on Shadownet. Pass `CURATOR` to `scripts/deploy-jurisdiction-suite.js` to hand them to governance.
