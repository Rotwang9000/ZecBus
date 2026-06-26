# ZecBus — leave the Zcash pool together

**ZecBus** coordinates **non-custodial** Zcash mixing. A *bus* is a rendezvous:
several people agree to leave the Zcash shielded pool with the **same blend-in
amount**, on the **same route** (ZEC → BTC/ETH/RUNE/…), in the **same short
window**. On-chain you become *N* indistinguishable look-alike swaps instead of
one lone, oddly-sized exit that links straight back to you.

Live at **[zecbus.com](https://zecbus.com)**. It's also a set of MCP tools, so an
AI agent can ride a bus on your behalf.

> **This is a coordination service, not a tumbler.** ZecBus holds **no funds and
> no keys**, and stores **no destinations or txids**. It only tracks *(route,
> blend-in amount, seat count, departure window)*. Each rider signs and
> broadcasts their **own** swap from their **own** wallet. The real anonymity set
> is how many *distinct* riders actually broadcast in the window — so the seat
> count is an **upper bound**, not a promise.

## v2 vs v1 (why this changed)

The original ZecBus (see git history) was **custodial**: riders sent ZEC to a
shared "bus" shielded address and the service swapped on their behalf. That is
money-transmission-shaped and concentrates risk. **v2 is coordination-only** — a
rendezvous that matches riders by amount/route/time; nobody ever hands their
coins to ZecBus.

## How it works

1. **Pick a blend-in amount + exit asset.** Choose a common denomination others
   also use (odd amounts fingerprint you) and where you're swapping ZEC to.
2. **Reserve a seat.** You join, or start, a bus for that exact amount + route.
   You get a **one-time seat token** — there's no account and nothing is stored
   about you. Save the token if you want to manage the seat after a reload.
3. **Wait for it to fill.** When enough riders board, the bus turns **ready** and
   a short departure window opens.
4. **Broadcast your own swap.** During the window, everyone broadcasts their own
   ZEC → asset swap from their own wallet, to a **fresh** destination. The
   look-alike swaps land together as one anonymity set.

## API (free, public)

The board runs on the winbit32 gateway. All endpoints are free and CORS-enabled.

| Method | Path | What |
| ------ | ---- | ---- |
| `GET`  | `/v1/zec/bus` | list boarding buses (`?to=BTC.BTC` to filter) |
| `GET`  | `/v1/zec/bus/:id` | one bus (`?seatId=&ownerToken=` for your seat) |
| `POST` | `/v1/zec/bus/join` | reserve a seat → returns a one-time `owner_token` |
| `POST` | `/v1/zec/bus/seat/:id/board` | confirm boarded (owner token) |
| `POST` | `/v1/zec/bus/seat/:id/leave` | withdraw your seat (owner token) |

```bash
# List buses
curl https://mcp.winbit32.com/v1/zec/bus

# Reserve a seat leaving the pool to BTC at a 1 ZEC blend-in amount
curl -X POST https://mcp.winbit32.com/v1/zec/bus/join \
  -H 'content-type: application/json' \
  -d '{"to":"BTC.BTC","amount":1,"minPassengers":5}'
```

## MCP (for agents)

Point any [Model Context Protocol](https://modelcontextprotocol.io) client at the
winbit32 gateway:

```json
{ "mcpServers": { "winbit32": { "url": "https://mcp.winbit32.com/mcp" } } }
```

Tools: `winbit32_zec_bus_list`, `winbit32_zec_bus_join`,
`winbit32_zec_bus_status`, `winbit32_zec_bus_board`, `winbit32_zec_bus_leave`.

```
zec_bus_join({ to: "BTC.BTC", amount: 1, minPassengers: 5 })
```

## Coming to WINBIT32

ZecBus is being built into [WINBIT32](https://winbit32.com)'s Privacy Suite and
Money Manager. There the bus is **wallet-connected**: when your bus is ready, one
click prefills the built-in Exchange to broadcast your own ZEC exit swap — no
copy-pasting amounts, no leaving the app. It sits alongside the Zcash
amount-privacy advisor (blend-in amounts + split planner) and the Monero / Dash
privacy tools.

**Next:** wiring the anonymous sybil-resistance layer (below) into the live
coordinator so seats are gated by zk membership proofs.

## This repo

```
site/                       standalone web app (static; served at zecbus.com)
  index.html / styles.css / app.js   live "departures board" UI; calls the
                            gateway's /v1/zec/bus + popular-amounts surface directly
src/reputation.js           sybil-resistance crypto core (Poseidon identity,
                            per-bus nullifier, Poseidon Merkle tree + witness)
src/nullifier-registry.js   coordinator-side "one seat per identity per bus" enforcement
src/client/proof.js         groth16 membership-proof generator (snarkjs)
src/client/verify.js        groth16 verifier + registry verifier factory
circuits/reputation.circom  the zk circuit (mirrors src/reputation.js 1:1)
circuits/build.sh           compile + Groth16 setup (needs circom; trusted ceremony for prod)
test/reputation.test.js     pure-model + registry tests (npm test → node --test)
```

The site is plain static HTML/CSS/JS — no build step. Open `site/index.html`
locally, or serve the `site/` folder with any static host; it talks to the live
gateway out of the box. The landing page is a live **departures board** —
boarding buses, station stats, a scrolling ticker and a UTC clock, all
auto-refreshing — with "how it works" as click-through. Quiet routes show as
joinable *scheduled* departures so the board never looks dead. It credits and
links [zecstats.com](https://zecstats.com) (the `amount-suggest` idea and the
[Wall of Shame](https://zecstats.com/wall-of-shame), which catalogues real
self-dox shield/deshield round-trips).

## Sybil resistance (P4c, in progress)

The honest limitation above — *a single actor could take several seats* — is what
this layer fixes, **without** deanonymising anyone or holding any keys. It's a
[Semaphore](https://semaphore.pse.dev/)-style scheme:

1. **Identity.** A rider has a secret `idSecret` and publishes
   `idCommitment = Poseidon(idSecret, idSalt)`. Commitments live as leaves in an
   identity **Merkle tree**.
2. **Boarding proof.** To take a seat the rider proves in zero knowledge that
   their committed identity is in the tree *and* reveals a per-bus
   `nullifier = Poseidon(idSecret, busKey)` — and nothing else. `busKey` is a
   public, deterministic label for the bus (`Poseidon`/SHA of its route, amount
   and id).
3. **Enforcement.** The coordinator verifies the proof and records the
   nullifier. A second seat from the same identity on the **same** bus reuses the
   same nullifier and is rejected → **one seat per identity per bus**. On any
   **other** bus the nullifier is different and unlinkable, and the identity is
   never revealed.

Run the model + enforcement tests (no toolchain needed):

```bash
npm install && npm test     # node --test — pure Poseidon model + registry
```

Build the zk artefacts (needs [circom](https://docs.circom.io)):

```bash
npm run build:circuit       # circuits/build.sh → wasm + proving/verification keys
```

`src/reputation.js` is the spec **and** the witness builder; `circuits/reputation.circom`
is the zk version of the exact same relations, so the two cannot drift.

**Where the sybil *cost* lives — registration.** One-seat-per-identity only
helps if minting identities isn't free. The Merkle leaf (`idCommitment`) is the
anchor: registration should require proving control of a distinct, scarce
credential — e.g. a Zcash spending/viewing key (derive `idSecret` from it), an
optional small fee, or proof-of-work. That registration policy, the multi-party
**trusted-setup ceremony** for the proving key (the bundled `build.sh` is a
single-contributor *dev* setup — do not ship its zkey), and wiring proof
verification into the live coordinator (an opt-in nullifier registry on the
gateway, mirroring `src/nullifier-registry.js`) plus in-browser proving are the
remaining steps.

## Honest limitations

Amount blending is **one signal among many**. Timing (broadcast in the window),
address reuse (use a fresh destination, don't recycle transparent change), and
network metadata all still matter. Until the reputation layer lands, treat the
seat count as an upper bound on the set — a single actor *could* take several
seats. ZecBus reduces linkability; it does not make a transaction private on its
own.

## License

MIT — see [LICENSE](LICENSE).
