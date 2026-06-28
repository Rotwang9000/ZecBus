// ZecBus sybil-resistance — cryptographic core (P4c).
//
// The "bus" coordinator is non-custodial and anonymous, so nothing normally
// stops one actor reserving many seats and shrinking everyone's anonymity set.
// This module is the pure, dependency-light reference model for a Semaphore-
// style fix:
//
//   * Each rider has a long-lived secret `idSecret` and an `idCommitment =
//     Poseidon(idSecret, idSalt)`. Commitments are inserted into an identity
//     Merkle tree (registration is where sybil *cost* lives — see README).
//   * To take a seat on a bus, the rider proves in zero knowledge that their
//     committed identity is in the tree (Merkle membership) and reveals a
//     per-bus `nullifier = Poseidon(idSecret, busKey)` — nothing else.
//   * `busKey` is a public, deterministic label for the bus. The same identity
//     always yields the same nullifier on the *same* bus (so the coordinator
//     rejects a second seat) but an *unlinkable* nullifier on every *other* bus
//     (different busKey → different nullifier, and the identity is never
//     revealed). So: one seat per identity per bus, without deanonymising anyone.
//
// Every relation here (idCommitment, nullifier, the Poseidon-2 Merkle hashing
// and path convention) is mirrored 1:1 by `circuits/reputation.circom`, so this
// model is both the spec and the witness builder for the zk prover.

import { createHash, createHmac, randomBytes } from 'node:crypto';

// BN254 / alt_bn128 scalar field — the field circom + snarkjs (groth16) work in.
export const FIELD_PRIME =
	21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const DEFAULT_TREE_DEPTH = 20; // 2^20 ≈ 1.05M identities

let _poseidonPromise = null;
// circomlibjs builds the Poseidon constants once (a few ms); cache the instance.
async function getPoseidon() {
	if (!_poseidonPromise) {
		_poseidonPromise = import('circomlibjs').then((m) => m.buildPoseidon());
	}
	return _poseidonPromise;
}

// Coerce to a canonical field element (bigint in [0, FIELD_PRIME)).
export function toField(x) {
	let v;
	if (typeof x === 'bigint') v = x;
	else if (typeof x === 'number') {
		if (!Number.isInteger(x)) throw new TypeError(`toField: non-integer number ${x}`);
		v = BigInt(x);
	} else if (typeof x === 'string') v = x.startsWith('0x') ? BigInt(x) : BigInt(x);
	else throw new TypeError(`toField: unsupported type ${typeof x}`);
	v %= FIELD_PRIME;
	if (v < 0n) v += FIELD_PRIME;
	return v;
}

// Poseidon hash of N field elements → bigint. (We always round-trip through the
// canonical decimal string so chained hashes stay in-field.)
export async function poseidonHash(inputs) {
	if (!Array.isArray(inputs) || inputs.length === 0) {
		throw new TypeError('poseidonHash: inputs must be a non-empty array');
	}
	const P = await getPoseidon();
	const out = P(inputs.map((i) => toField(i)));
	return BigInt(P.F.toString(out));
}

const h2 = (P, a, b) => BigInt(P.F.toString(P([toField(a), toField(b)])));

// A cryptographically random field scalar (for secrets / salts). The modulo
// bias is ~2^-252 (32 random bytes vs a ~2^254 field), negligible here.
export function randomFieldScalar() {
	return BigInt('0x' + randomBytes(32).toString('hex')) % FIELD_PRIME;
}

// ── identity ────────────────────────────────────────────────────────
// `secret` should be anchored to something the rider controls and that is
// costly to mint en masse (e.g. derived from a Zcash spending/viewing key) —
// that anchoring is the sybil-cost lever (README "Registration"). Here we just
// take/return field scalars.
export async function deriveIdentity({ secret, salt } = {}) {
	const idSecret = secret == null ? randomFieldScalar() : toField(secret);
	const idSalt = salt == null ? randomFieldScalar() : toField(salt);
	const idCommitment = await poseidonHash([idSecret, idSalt]);
	return { idSecret, idSalt, idCommitment };
}

export async function nullifierFor(idSecret, busKey) {
	return poseidonHash([toField(idSecret), toField(busKey)]);
}

// ── registration anchor: where sybil COST lives ──────────────────────
// A random identity is free to mint, so a random tree would offer no sybil
// resistance — the anonymity set is only as honest as the cost of a new leaf.
// We therefore derive the identity *deterministically* from an `anchor`: a
// secret the rider already controls that is costly/scarce to mint en masse —
// canonically a Zcash spending or full viewing key (one per funded wallet), but
// the same construction works for any scarce secret (a paid attestation, a
// PoW preimage, a hardware-key signature…). Properties:
//   • deterministic — the same anchor reproduces the same identity, so a rider
//     can re-derive (and re-prove) after a reload WITHOUT ever storing idSecret;
//   • domain-separated — the anchor is never usable as a spend key here, and
//     `context` lets one anchor yield independent identities per app/epoch;
//   • one-way — HMAC-SHA512 over the anchor; the commitment/nullifier never
//     leak the anchor.
// The TREE OPERATOR still decides which commitments to admit (e.g. "prove this
// anchor is a UFVK that controls ≥ X confirmed ZEC"); that admission policy is
// the actual sybil price. This function only makes the identity reproducible
// and bound to the anchor.
export const ANCHOR_DOMAIN = 'zecbus:v2:identity';

function hmacField(anchorKey, label) {
	const mac = createHmac('sha512', Buffer.from(String(anchorKey), 'utf8'))
		.update(`${ANCHOR_DOMAIN}|${label}`, 'utf8')
		.digest('hex');
	return BigInt('0x' + mac) % FIELD_PRIME;
}

export async function deriveIdentityFromAnchor({ anchor, context = 'default' } = {}) {
	if (anchor == null || String(anchor).length === 0) {
		throw new TypeError('deriveIdentityFromAnchor: an `anchor` secret is required');
	}
	const ctx = String(context);
	const idSecret = hmacField(anchor, `secret|${ctx}`);
	const idSalt = hmacField(anchor, `salt|${ctx}`);
	const idCommitment = await poseidonHash([idSecret, idSalt]);
	return { idSecret, idSalt, idCommitment };
}

// ── busKey: public, deterministic per-bus label ──────────────────────
// Both the rider and the coordinator must compute the identical value. We hash
// the immutable, public facts of a bus (never anything secret) into the field.
export function canonicalBusDescriptor(bus) {
	// Accept either the crypto-core shape ({from,to,amountZats,id}) or a gateway
	// bus summary verbatim ({from_asset,to_asset,amount_zat,id}) so a rider can
	// feed the JSON they got from /v1/zec/bus straight in — the string MUST stay
	// byte-identical to the gateway's busKeyForBus() (see payments-gateway).
	const from = String(bus.from ?? bus.from_asset ?? 'ZEC.ZEC');
	const to = String(bus.to ?? bus.to_asset ?? '');
	const amountZats = String(bus.amountZats ?? bus.amount_zats ?? bus.amount_zat ?? bus.amount);
	const id = String(bus.id);
	if (!to || !id || amountZats === 'undefined') {
		throw new TypeError('canonicalBusDescriptor: bus needs { to, amountZats, id }');
	}
	return `zecbus:v2:${from}|${to}|${amountZats}|${id}`;
}

export function busKeyFromDescriptor(descriptor) {
	const hex = createHash('sha256').update(String(descriptor), 'utf8').digest('hex');
	return BigInt('0x' + hex) % FIELD_PRIME;
}

export function busKeyFor(bus) {
	return busKeyFromDescriptor(canonicalBusDescriptor(bus));
}

// ── Poseidon Merkle tree (binary, Poseidon-2) ────────────────────────
let _zerosCache = null;
async function zeros(depth) {
	if (_zerosCache && _zerosCache.length > depth) return _zerosCache;
	const P = await getPoseidon();
	const z = [0n];
	for (let i = 1; i <= depth; i++) z.push(h2(P, z[i - 1], z[i - 1]));
	_zerosCache = z;
	return z;
}

// leaves: array of bigint identity commitments (index = registration order).
export async function buildMerkleTree(leaves, depth = DEFAULT_TREE_DEPTH) {
	const P = await getPoseidon();
	const z = await zeros(depth);
	const layers = [leaves.map(toField)];
	let cur = layers[0];
	for (let level = 0; level < depth; level++) {
		const next = [];
		for (let i = 0; i < cur.length; i += 2) {
			const left = cur[i];
			const right = i + 1 < cur.length ? cur[i + 1] : z[level];
			next.push(h2(P, left, right));
		}
		if (next.length === 0) next.push(h2(P, z[level], z[level])); // empty tree
		layers.push(next);
		cur = next;
	}
	return { root: cur[0], layers, depth };
}

// Membership witness for the leaf at `index`, matching the circuit's path
// convention: pathIndices[level] === 1 ⇒ the current node is the RIGHT child.
export async function merkleProof(tree, index) {
	const depth = tree.depth;
	const z = await zeros(depth);
	const pathElements = [];
	const pathIndices = [];
	let idx = index;
	for (let level = 0; level < depth; level++) {
		const layer = tree.layers[level] || [];
		const isRight = idx & 1;
		const sibIdx = isRight ? idx - 1 : idx + 1;
		const sib = sibIdx < layer.length ? layer[sibIdx] : z[level];
		pathElements.push(sib);
		pathIndices.push(isRight);
		idx = Math.floor(idx / 2);
	}
	return { pathElements, pathIndices };
}

// Recompute a root from a leaf + witness (the exact computation the circuit
// constrains). Returns the recomputed root as bigint.
export async function merkleRootFromProof(leaf, pathElements, pathIndices) {
	if (pathElements.length !== pathIndices.length) {
		throw new TypeError('merkleRootFromProof: path length mismatch');
	}
	const P = await getPoseidon();
	let cur = toField(leaf);
	for (let i = 0; i < pathElements.length; i++) {
		const sib = toField(pathElements[i]);
		cur = pathIndices[i] ? h2(P, sib, cur) : h2(P, cur, sib);
	}
	return cur;
}

export async function verifyMerkleProof(leaf, pathElements, pathIndices, root) {
	const recomputed = await merkleRootFromProof(leaf, pathElements, pathIndices);
	return recomputed === toField(root);
}

// Build the full public/private witness for a bus-membership proof — the inputs
// `circuits/reputation.circom` expects. The prover (src/client/proof.js) feeds
// this straight into snarkjs.
export async function buildBusWitness({ identity, tree, index, bus, busKey }) {
	const key = busKey != null ? toField(busKey) : busKeyFor(bus);
	const { pathElements, pathIndices } = await merkleProof(tree, index);
	const nullifier = await nullifierFor(identity.idSecret, key);
	return {
		// private
		idSecret: identity.idSecret,
		idSalt: identity.idSalt,
		pathElements,
		pathIndices,
		// public
		merkleRoot: tree.root,
		busKey: key,
		nullifier,
	};
}
