# Docs index

The specification of the On-Chain Jurisdiction contracts. For the overview, start at the repo-root [`README.md`](../README.md), which reads as the paper and links into these docs section by section.

**Status (October 2026): beta on testnet.** The full suite is deployed on Etherlink Shadownet (chainId 127823); the Ghostnet testnet is retired. Addresses and deploy flow: [`deployments.md`](deployments.md).

## Specification

| Doc | What it covers |
|-----|----------------|
| [`architecture.md`](architecture.md) | Contract graph, factory and sub-factory deployment flow, how the indexer and the two web apps consume events. |
| [`governance.md`](governance.md) | Governor, Timelock, Registry, RepToken (non-transferable, transferable, wrapped), delegation, reward epochs. |
| [`economy.md`](economy.md) | The trustless economy: project lifecycle, cooling-off, escrow, platform fees, backer voting, arbitration, appeals, reputation accrual. |
| [`immediate-release.md`](immediate-release.md) | Releasing part of a contribution to the contractor at signing. |
| [`registry-settings.md`](registry-settings.md) | Registry keys the economy and RepToken read, including the parity convention. |
| [`autonet.md`](autonet.md) | Jurisdiction-side Autonet satellites: AutonetVault, AutonetRepClaim, CoinOffering, the deprecated ReputationMirror, and the experimental training contracts. |
| [`security.md`](security.md) | Threat model and the on-chain mitigations for each threat. |
| [`technical-reference.md`](technical-reference.md) | Functions, parameters, constants, events and access control per contract. |
| [`deployments.md`](deployments.md) | Deployed addresses, deploy scripts, networks, and the local end-to-end harness. |

## Reference

| Doc | What it covers |
|-----|----------------|
| [`firestore-schema.md`](firestore-schema.md) | Firestore layout the indexer writes and the trustless.business app reads. |
| [`existing-solutions.md`](existing-solutions.md) | Kleros, Aragon Court and other decentralized justice systems, and how this design differs. |
