# Trustless Economy Firestore Schema

This document describes the Firestore database structure for the Trustless Economy platform.

## Overview

The Trustless Economy uses a hierarchical structure where:
- **Network** is the root collection (e.g., `Etherlink-Testnet`)
- **Economy** documents represent deployed Economy DAOs
- **Projects** are nested subcollections within each Economy

## Schema Structure

```
contracts/                                    [collection - configuration]
  └── {networkName}/                          [document - network config]
        ├── chainId: number
        ├── rpc: string
        ├── blockExplorer: string
        ├── symbol: string
        ├── arbitrationFee: string
        ├── wrapper_trustless: string         [TrustlessFactory address]
        ├── nativeProjectImpl: string         [NativeProject implementation]
        └── erc20ProjectImpl: string          [ERC20Project implementation]

{networkName}/                                [collection - e.g., "Etherlink-Testnet"]
  └── {economyAddress}/                       [document - Economy instance]
        ├── address: string                   [Economy contract address]
        ├── daoAddress: string                [Governor contract address]
        ├── registryAddress: string           [Registry/Treasury address]
        ├── timelockAddress: string           [Timelock controller address]
        ├── repTokenAddress: string           [RepToken governance token]
        ├── creator: string                   [Deployer address]
        ├── createdAt: timestamp
        ├── createdAtBlock: number
        │
        └── projects/                         [subcollection]
              └── {projectAddress}/           [document - Project instance]
                    ├── address: string       [Project contract address]
                    ├── name: string
                    ├── description: string
                    ├── author: string        [Project creator address]
                    ├── contractor: string    [Assigned contractor, 0x0 if none]
                    ├── arbiter: string       [Designated arbiter, 0x0 if none]
                    ├── amount: string        [Funding amount in wei]
                    ├── tokenAddress: string  [Payment token, 0x0 = native currency]
                    ├── termsHash: string     [Hash of terms document]
                    ├── repo: string          [Link to terms/repository]
                    ├── stage: string         [Project lifecycle stage]
                    ├── createdAt: timestamp
                    ├── votesToRelease: []    [Backer addresses voting to release]
                    └── votesToDispute: []    [Backer addresses voting to dispute]
```

## Collections

### `contracts/{networkName}`

Network configuration document. Contains factory addresses and network settings.

| Field | Type | Description |
|-------|------|-------------|
| `chainId` | number | Network chain ID (e.g., 128123 for Etherlink Testnet) |
| `rpc` | string | RPC endpoint URL |
| `blockExplorer` | string | Block explorer base URL |
| `symbol` | string | Native currency symbol (e.g., "XTZ") |
| `arbitrationFee` | string | Default arbitration fee |
| `wrapper_trustless` | string | TrustlessFactory contract address |
| `nativeProjectImpl` | string | NativeProject implementation address |
| `erc20ProjectImpl` | string | ERC20Project implementation address |

**Example path:** `contracts/Etherlink-Testnet`

### `{networkName}/{economyAddress}`

Economy document. Created when a new Economy DAO is deployed via TrustlessFactory.

| Field | Type | Description |
|-------|------|-------------|
| `address` | string | Economy contract address |
| `daoAddress` | string | Governor contract address |
| `registryAddress` | string | Registry (treasury) contract address |
| `timelockAddress` | string | TimelockController address |
| `repTokenAddress` | string | RepToken governance token address |
| `creator` | string | Address that deployed the Economy DAO |
| `createdAt` | timestamp | Deployment timestamp |
| `createdAtBlock` | number | Block number of deployment |

**Example path:** `Etherlink-Testnet/0xB40e377b3633B12a04804A5007c0B47dE21cB3bC`

### `{networkName}/{economyAddress}/projects/{projectAddress}`

Project document. Created when a new project is created within an Economy.

| Field | Type | Description |
|-------|------|-------------|
| `address` | string | Project contract address |
| `name` | string | Project name |
| `description` | string | Project description |
| `author` | string | Address that created the project |
| `contractor` | string | Assigned contractor address (0x0 if open) |
| `arbiter` | string | Designated arbiter address (0x0 if none) |
| `amount` | string | Total funding amount in wei |
| `tokenAddress` | string | Payment token address (0x0 = native currency) |
| `termsHash` | string | Hash of terms document (empty if none) |
| `repo` | string | URL to terms/repository |
| `stage` | string | Current project stage |
| `createdAt` | timestamp | Project creation timestamp |
| `votesToRelease` | array | Addresses of backers voting to release funds |
| `votesToDispute` | array | Addresses of backers voting to dispute |

**Example path:** `Etherlink-Testnet/0xB40e377b3633B12a04804A5007c0B47dE21cB3bC/projects/0x1234...`

## Project Stages

The `stage` field indicates the project's lifecycle state:

| Stage | Description |
|-------|-------------|
| `open` | Project is open for funding/contractor assignment |
| `pending` | Work in progress, awaiting completion |
| `completed` | Work submitted, in cooling-off period |
| `released` | Funds released to contractor |
| `disputed` | Dispute raised, awaiting resolution |
| `appealed` | Arbiter decision appealed to DAO |
| `cancelled` | Project cancelled |

## Special Addresses

| Address | Meaning |
|---------|---------|
| `0x0000000000000000000000000000000000000000` | No contractor/arbiter assigned, or native currency |
| `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` | Native currency (in tokenAddress context) |

## Querying Examples

### Get all Economies on a network
```javascript
const economies = await db.collection('Etherlink-Testnet').get();
```

### Get all projects in an Economy
```javascript
const projects = await db
  .collection('Etherlink-Testnet')
  .doc(economyAddress)
  .collection('projects')
  .get();
```

### Get projects by author
```javascript
const myProjects = await db
  .collection('Etherlink-Testnet')
  .doc(economyAddress)
  .collection('projects')
  .where('author', '==', userAddress)
  .get();
```

### Get open projects
```javascript
const openProjects = await db
  .collection('Etherlink-Testnet')
  .doc(economyAddress)
  .collection('projects')
  .where('stage', '==', 'open')
  .get();
```

## Migration Notes

### Previous Schema (Deprecated)

The previous schema stored projects as top-level documents:

```
{networkName}/
  └── {projectAddress}/     [document - flat structure]
```

### New Schema (Current)

Projects are now nested under their parent Economy:

```
{networkName}/
  └── {economyAddress}/     [document - Economy]
        └── projects/       [subcollection]
              └── {projectAddress}/
```

### Why the Change?

1. **Hierarchy:** Projects belong to specific Economies, now reflected in structure
2. **Scalability:** Multiple Economies per network with isolated project collections
3. **Querying:** Easier to get all projects for a specific Economy
4. **Future-proofing:** Allows for Economy-level settings and metadata

## Network Names

| Environment | Network Name |
|-------------|--------------|
| Mainnet | `Etherlink` |
| Testnet | `Etherlink-Testnet` |
| Localhost | `Localhost` |
