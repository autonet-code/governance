# Modules

A module is an optional part of a jurisdiction (the Autonet layer, the ContentCourt, ...) built from a module factory in `contracts/modules/`. A DAO is created from a core type (Standard or Economy) plus any modules, and can add or remove modules later by proposal. Modules need the Economy core: their verdicts wait out the Economy's appeal window.

## Install, then attach

A module joins a jurisdiction in two steps.

1. **Install.** Anyone calls the factory's typed `install` (for AutonetGenesis, `launch`) with the jurisdiction's addresses (`Jurisdiction { registry, timelock, repToken, economy, dao }`) and the module's parameters. It deploys the module's contracts wired to that jurisdiction and returns an installation id (also `lastInstallBy(installer)`). An installed module has no rights, so installing is harmless.
2. **Attach.** The jurisdiction grants what the installation's `manifest(id)` lists: RepToken `minters` and `slashers`, plus Registry entries. Every manifest includes `modules.<name>` = `"<factory>:<id>"`, so a jurisdiction's attached modules can be read from its Registry.

Attaching happens at one of two points:

- **At origination.** The founder installs each module between `deployDAOToken` and finalize, then passes the merged manifests to `TrustlessFactory.configureAndFinalizeWithGrants(..., keys, values, minters, slashers)`. The factory makes the grants while it is still the RepToken admin, so no proposal is needed.
- **After origination.** A member installs the module, then proposes the actions from `ModuleAttacher.attachCalls(factory, id)`. `detachCalls(factory, id)` builds the reverse proposal: it revokes the grants and clears the entries. Both first check that the installation's Registry, Timelock, RepToken and Economy all point at each other (`NotAJurisdiction` otherwise), so the proposal can't attach a module that answers to a different jurisdiction.

The Registry lists a cleared key only once, so a module can be detached and attached again.

## Factories

| Module (`moduleName`) | Factory | Install | Grants | Registry entries |
|---|---|---|---|---|
| `autonet` | `AutonetGenesis` | `launch(j, AutonetParams, ToolBond.Params)` | REP claim (minter), ToolBond (slasher) | `jurisdiction.autonet.*` ([autonet.md](autonet.md#genesis-autonetgenesis)) |
| `content_court` | `ContentCourtFactory` | `install(j, ContentCourt.Params)` | court (slasher) | `jurisdiction.content_court.court` ([content-court.md](content-court.md)) |

Each factory extends `ModuleFactory` (ids, jurisdictions, the marker entry) and implements `IModuleFactory`. To add a module, write a factory with a typed `install` that calls `_register(j)`, and a `manifest(id)` built from `_manifest(id, entries, minters, slashers)`.

## Trust

A proposal built by `ModuleAttacher` grants whatever the factory's manifest lists, so voters are trusting the factory. Front ends offer only the factories on the network's list: the Firestore field `modules` (name → factory) in `contracts/<network>`, written by `scripts/deployFullFactorySuiteShadownet.js` with `moduleAttacher`.
