# ZecBus — leave the Zcash pool together

**ZecBus** coordinates **non-custodial** Zcash mixing. A *bus* is a rendezvous:
several people cross the **same pool boundary** with the **same blend-in
amount**, in the **same short window**. On-chain you become *N* indistinguishable
look-alike moves instead of one lone, oddly-sized one that links straight back to
you. Three boundaries (`kind`):

- **Swap out** — leave the shielded pool to another chain (ZEC → BTC/ETH/RUNE/…).
- **Unshield** (z→t) — leave to *transparent* ZEC together.
- **Shield** (t→z) — *enter* the shielded pool from transparent ZEC together.

Shield/unshield are the direct fix for the **[Wall of Shame](https://zecstats.com/wall-of-shame)**
self-dox: people round-trip a *unique* amount in and out of the pool 1:1, which
links the two legs. A bus makes everyone's transparent leg the same round amount
at the same time, so they look alike instead.

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

1. **Pick a boundary + blend-in amount.** Choose the `kind` (swap out / unshield
   / shield) and a common denomination others also use (odd amounts fingerprint
   you). For a swap, also pick the exit asset.
2. **Reserve a seat.** You join, or start, a bus for that exact kind + amount
   (+ route). You get a **one-time seat token** — there's no account and nothing
   is stored about you. Save the token if you want to manage the seat after a
   reload.
3. **Wait for it to fill.** When enough riders board, the bus turns **ready** and
   a short departure window opens.
4. **Broadcast your own move.** During the window, everyone broadcasts their own
   swap / unshield / shield from their own wallet (to a **fresh** destination for
   swaps). The look-alike moves land together as one anonymity set.

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
# List buses (?kind=unshield|shield, or ?to=BTC.BTC for a swap destination)
curl https://mcp.winbit32.com/v1/zec/bus

# Reserve a seat leaving the pool to BTC at a 1 ZEC blend-in amount
curl -X POST https://mcp.winbit32.com/v1/zec/bus/join \
  -H 'content-type: application/json' \
  -d '{"kind":"swap","to":"BTC.BTC","amount":1,"minPassengers":5}'

# …or unshield (z→t) together — no destination asset, just the amount
curl -X POST https://mcp.winbit32.com/v1/zec/bus/join \
  -H 'content-type: application/json' \
  -d '{"kind":"unshield","amount":1,"minPassengers":5}'
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

The **swap out / unshield / shield** selector is wired through the live board,
the in-app Privacy-Suite panel, the gateway and the MCP tools.

**Next:** running a real trusted-setup ceremony so the opt-in sybil gate (below)
can be switched on in production.

## This repo

```
site/                       standalone web app (static; served at zecbus.com)
  index.html / styles.css / app.js   live "departures board" UI (swap/unshield/
                            shield tabs); calls the gateway's /v1/zec/bus +
                            popular-amounts surface directly
src/reputation.js           sybil-resistance crypto core (Poseidon identity +
                            anchor derivation, per-bus nullifier, Merkle witness)
src/nullifier-registry.js   in-memory "one seat per identity per bus" reference model
src/client/proof.js         groth16 membership-proof generator (snarkjs)
src/client/verify.js        groth16 verifier + registry verifier factory
src/client/browser.js       in-browser prover: anchor → identity → leaf → proof
circuits/reputation.circom  the zk circuit (mirrors src/reputation.js 1:1)
circuits/build.sh           DEV compile + single-contributor Groth16 setup (circom)
circuits/ceremony.sh        PRODUCTION multi-contributor phase-2 ceremony (snarkjs)
test/*.test.js              pure-model, registry + browser-client tests (node --test)
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

**Boarding is a modal**, not a scroll: tapping *Board*/*Start* (or the header
*🎟 Board* button) opens the ticket office as a centred dialog over a blurred
board, so you never lose your place. The modal state is mirrored to the URL
(`?board=1&kind=…&to=…&amount=…&min=…&bus=…`), so a shared link **re-opens the
right bus** — joining is by cohort (`kind`+amount+route+min), so the link lands
you on the same bus even if that exact instance already rolled. A *🔗 Copy share
link* button grabs the current URL; `Esc`/✕/backdrop-click closes and clears it.

When a bus is **ready**, the ticket offers an **optional** "do it in your
browser" hand-off: it deep-links [WINBIT32](https://winbit32.com)'s built-in
Exchange prefilled (`#winbit32.exe/exchange.exe/token_from=ZEC.ZEC&token_to=…&amount=…`)
so the rider connects *their own* wallet there and broadcasts — swaps through it
carry WINBIT32's standard affiliate fee. It is deliberately secondary:
**broadcasting from your own wallet stays the default**, and ZecBus never holds
funds or keys either way. (The static site doesn't embed `@winbit32/wallet-kit`
itself — that's a CommonJS, bundler-only Zcash/Monero + FROST-cosign kit with no
swap engine; the swap/exchange lives in WINBIT32, so the site hands off to it.)

## Sybil resistance (P4c)

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
anchor: `reputation.deriveIdentityFromAnchor({ anchor, context })` derives the
identity **deterministically** from a scarce secret the rider already controls —
canonically a Zcash spending/viewing key (one per funded wallet) — so it's
reproducible after a reload without ever storing `idSecret`, and the *tree
operator's* admission policy (e.g. "prove this key controls ≥ X confirmed ZEC")
is the actual price. The anchor never leaks (HMAC-SHA512, domain-separated), and
`context` yields independent identities per app/epoch.

### Status

| Piece | State |
| ----- | ----- |
| Poseidon identity / nullifier / Merkle model + circuit | ✅ `src/reputation.js` ⇄ `circuits/reputation.circom` |
| Registration **anchor** (deterministic, scarce identity) | ✅ `deriveIdentityFromAnchor` |
| **In-browser proving** (anchor → leaf → groth16 bundle) | ✅ `src/client/browser.js` |
| **Coordinator gate** on the gateway (durable nullifier registry, off by default) | ✅ `payments-gateway` `zcash-bus-nullifiers.js` + `/v1/zec/bus/open` → `/join` with a proof |
| Production **trusted-setup ceremony** | ⏳ script ready (`circuits/ceremony.sh`); needs real contributors |

The gateway gate is **opt-in** (`ZEC_BUS_SYBIL_REQUIRED`, off by default) and
takes an **injected** verifier, so `snarkjs`/`.zkey` never become gateway
dependencies and the free public board keeps working anonymously until a real
ceremony has produced a verification key. Each bus publishes a `bus_key` the
proof must bind to; the gateway dedupes the revealed nullifier per bus
(SQLite-durable, race-safe), and a rider who **leaves** frees their seat.

**Why two calls (`open` then `join`).** The proof binds to a bus's `bus_key`,
which is derived from *that bus's own descriptor* (id + route + amount) — so a
rider has to know which bus they're boarding **before** they can prove. A
sybil-mode client therefore first calls `POST /v1/zec/bus/open`, which finds-or-creates the
matching bus and returns its `bus_key` **without taking a seat**; the client
proves against that key, then `POST /v1/zec/bus/join {busId, proof}` claims the
seat. Keeping one stable key *per bus* (rather than a cohort-wide key) means
repeat boarders prove against the same key with no epoch rotation, and the proof
is bound to exactly the bus the rider sees — the coordinator can't quietly swap
them onto a smaller set. This split is invisible on the anonymous (default) path,
where a single `join` still works.

The on-chain `busKey` derivation is pinned by a shared test vector in **both**
repos (`test/reputation.test.js` ⇄ payments-gateway `test/zcash-bus-sybil.test.js`)
so the prover and coordinator can never silently disagree on a bus's key.

### Production ceremony

`circuits/build.sh` is a single-contributor **dev** setup — that contributor
could forge proofs, so **never ship its `.zkey`**. For production run the
multi-party phase-2 ceremony; the setup is sound as long as *one* contributor was
honest:

```bash
circuits/ceremony.sh init                                 # coordinator: r1cs + ptau → 0000.zkey
circuits/ceremony.sh contribute in.zkey out.zkey          # each participant adds entropy (own machine)
circuits/ceremony.sh finalize  last.zkey [beaconHex]      # public beacon → verify chain → export vkey
```

Publish every contribution hash, the beacon, the final `verification_key.json`
and the `zkey verify` transcript; contributors then destroy their entropy.

## Honest limitations

Amount blending is **one signal among many**. Timing (broadcast in the window),
address reuse (use a fresh destination, don't recycle transparent change), and
network metadata all still matter. Until the sybil gate is switched on in
production (it needs a real ceremony first), treat the seat count as an upper
bound on the set — a single actor *could* take several seats. ZecBus reduces
linkability; it does not make a transaction private on its own.

## License

MIT — see [LICENSE](LICENSE).
