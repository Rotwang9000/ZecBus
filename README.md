# Zcash Bus Station

**Zcash Bus Station** is an open-source, decentralized tool for coordinating anonymous ZEC-to-RUNE swaps via Maya Protocol or THORChain. Users send Zcash (ZEC) to a shielded address with a memo specifying swap details, and the system collates these into "buses" for coordinated swaps, enhancing privacy by obscuring transaction trails. The service reads directly from the Zcash blockchain, caches bus state on IPFS, and avoids central data storage. A zk-SNARK-based reputation system rewards loyal users with privacy-preserving badges, tied to this instance for stickiness.

## Features
- **Privacy-Preserving Swaps**: Coordinate ZEC-to-RUNE swaps with shielded transactions and encrypted memos to obscure transaction links.
- **Flexible Buses**: Support buses with varying minimum passenger counts (e.g., 3, 5, 10) for faster filling.
- **Decentralized Caching**: Cache bus state on IPFS to reduce blockchain scanning, maintaining decentralization.
- **zk-SNARK Reputation**: Prove past participation anonymously with zk-SNARKs, earning badges like "Veteran Rider."
- **No Central Storage**: All data is read from the Zcash blockchain or IPFS, ensuring no central server.
- **Open-Source**: Fully transparent codebase, encouraging community contributions and audits.

## How It Works
1. **Join a Bus**: Users send ZEC (with a small fee, e.g., 0.01 ZEC) to a bus’s shielded address, including a memo like `amount:min_passengers:target_address` (e.g., `100:5:thor1...`).
2. **Bus Formation**: The website reads memos from the blockchain, caches state on IPFS, and displays progress (e.g., "Bus #123: 3/5 passengers, 60/100 ZEC").
3. **Swap Execution**: When a bus fills, ZEC is swapped to RUNE via Maya/THORChain and sent to target addresses. Unfilled buses refund ZEC after 48 hours.
4. **Reputation**: Users submit zk-SNARK proofs of past bus participations to earn badges, encouraging loyalty.

## Getting Started
### Prerequisites
- A Zcash wallet supporting shielded transactions (e.g., YWallet, Zcashd).
- Access to a Zcash node or lightwalletd for blockchain queries.
- (Optional) IPFS node for caching bus state.
- Node.js and a browser for the website and CLI tools.

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/zcash-bus-station.git
   cd zcash-bus-station

Install dependencies:bash

npm install

Configure your Zcash node or lightwalletd endpoint in config.json.
Run the website locally or pin to IPFS:bash

npm start
# or
ipfs add -r dist/ && ipfs pin

UsageVisit the website (local or IPFS-hosted) to view or join buses.
Use the memo generator to create a valid memo (e.g., 100:5:thor1...).
Send ZEC to the bus’s shielded address with the memo.
Submit a zk-SNARK reputation proof (optional) to display your badge.
Monitor bus progress and await swap execution.

ContributingWe welcome contributions! Please see CONTRIBUTING.md for guidelines. Join our community on [Discord/Forum link] to discuss ideas, report bugs, or propose features.LicenseThis project is licensed under the MIT License - see LICENSE for details.StatusThis project is in early development. Current features include a basic website and memo parser. Upcoming features: IPFS caching, zk-SNARK reputation, and CLI tool.ContactFor questions or support, open an issue or join our [community channel].

