// P4c crypto-core tests — run with `npm test` (node --test, no extra tooling).
//
// These exercise the pure model and the coordinator registry. The registry's
// injected proof-verifier is a REAL Poseidon recomputation (membership +
// nullifier), not a stub — it genuinely validates the witness, just without the
// groth16 zk wrapper (which needs the compiled .zkey from circuits/build.sh).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	FIELD_PRIME,
	toField,
	deriveIdentity,
	nullifierFor,
	busKeyFor,
	canonicalBusDescriptor,
	buildMerkleTree,
	merkleProof,
	verifyMerkleProof,
	merkleRootFromProof,
	buildBusWitness,
} from '../src/reputation.js';

import {
	createRegistry,
	claimNullifier,
	claimSeat,
	hasNullifier,
	seatCount,
	releaseNullifier,
} from '../src/nullifier-registry.js';

const BUS_A = { from: 'ZEC.ZEC', to: 'BTC.BTC', amountZats: 100000000, id: 'bus_aaa' };
const BUS_B = { from: 'ZEC.ZEC', to: 'ETH.ETH', amountZats: 100000000, id: 'bus_bbb' };

test('toField wraps into the BN254 scalar field', () => {
	assert.equal(toField(0n), 0n);
	assert.equal(toField(5), 5n);
	assert.equal(toField(FIELD_PRIME), 0n);
	assert.equal(toField(FIELD_PRIME + 7n), 7n);
	assert.ok(toField('0x10') === 16n);
});

test('identity commitment is deterministic and salt-sensitive', async () => {
	const a = await deriveIdentity({ secret: 1234n, salt: 1n });
	const b = await deriveIdentity({ secret: 1234n, salt: 1n });
	const c = await deriveIdentity({ secret: 1234n, salt: 2n });
	assert.equal(a.idCommitment, b.idCommitment);
	assert.notEqual(a.idCommitment, c.idCommitment);
	assert.ok(a.idCommitment > 0n && a.idCommitment < FIELD_PRIME);
});

test('random identities differ', async () => {
	const a = await deriveIdentity();
	const b = await deriveIdentity();
	assert.notEqual(a.idSecret, b.idSecret);
	assert.notEqual(a.idCommitment, b.idCommitment);
});

test('nullifier: deterministic, unlinkable across buses, distinct per identity', async () => {
	const id1 = await deriveIdentity({ secret: 111n, salt: 9n });
	const id2 = await deriveIdentity({ secret: 222n, salt: 9n });
	const kA = busKeyFor(BUS_A);
	const kB = busKeyFor(BUS_B);

	const n1A = await nullifierFor(id1.idSecret, kA);
	const n1A2 = await nullifierFor(id1.idSecret, kA);
	const n1B = await nullifierFor(id1.idSecret, kB);
	const n2A = await nullifierFor(id2.idSecret, kA);

	assert.equal(n1A, n1A2, 'same identity + same bus ⇒ same nullifier (dedupe works)');
	assert.notEqual(n1A, n1B, 'same identity, different bus ⇒ unlinkable nullifier');
	assert.notEqual(n1A, n2A, 'different identity, same bus ⇒ different nullifier');
});

test('busKey is deterministic and per-bus', () => {
	assert.equal(busKeyFor(BUS_A), busKeyFor({ ...BUS_A }));
	assert.notEqual(busKeyFor(BUS_A), busKeyFor(BUS_B));
	assert.match(canonicalBusDescriptor(BUS_A), /^zecbus:v2:ZEC\.ZEC\|BTC\.BTC\|100000000\|bus_aaa$/);
	assert.throws(() => canonicalBusDescriptor({ to: 'BTC.BTC' }), /needs/);
});

test('Merkle membership verifies for every leaf and fails on tampering', async () => {
	const ids = [];
	for (let i = 0; i < 5; i++) ids.push(await deriveIdentity({ secret: BigInt(1000 + i), salt: 7n }));
	const tree = await buildMerkleTree(ids.map((i) => i.idCommitment));

	for (let i = 0; i < ids.length; i++) {
		const { pathElements, pathIndices } = await merkleProof(tree, i);
		assert.ok(await verifyMerkleProof(ids[i].idCommitment, pathElements, pathIndices, tree.root), `leaf ${i}`);
		// recomputed root equals the tree root (what the circuit constrains)
		assert.equal(await merkleRootFromProof(ids[i].idCommitment, pathElements, pathIndices), tree.root);
	}

	// Wrong leaf ⇒ wrong root.
	const p0 = await merkleProof(tree, 0);
	assert.equal(await verifyMerkleProof(ids[1].idCommitment, p0.pathElements, p0.pathIndices, tree.root), false);
	// Tampered sibling ⇒ fails.
	const bad = { ...p0, pathElements: [...p0.pathElements] };
	bad.pathElements[0] = bad.pathElements[0] + 1n;
	assert.equal(await verifyMerkleProof(ids[0].idCommitment, bad.pathElements, bad.pathIndices, tree.root), false);
});

test('buildBusWitness produces a consistent public/private witness', async () => {
	const ids = [];
	for (let i = 0; i < 3; i++) ids.push(await deriveIdentity({ secret: BigInt(50 + i), salt: 3n }));
	const tree = await buildMerkleTree(ids.map((i) => i.idCommitment));

	const w = await buildBusWitness({ identity: ids[2], tree, index: 2, bus: BUS_A });
	assert.equal(w.busKey, busKeyFor(BUS_A));
	assert.equal(w.merkleRoot, tree.root);
	assert.equal(w.nullifier, await nullifierFor(ids[2].idSecret, w.busKey));
	assert.equal(await merkleRootFromProof(ids[2].idCommitment, w.pathElements, w.pathIndices), tree.root);
});

test('registry dedupes nullifiers per bus', () => {
	const reg = createRegistry();
	const kA = '42';
	assert.equal(claimNullifier(reg, kA, 'n1').ok, true);
	assert.equal(hasNullifier(reg, kA, 'n1'), true);
	assert.equal(claimNullifier(reg, kA, 'n1').ok, false); // duplicate
	assert.equal(claimNullifier(reg, kA, 'n2').ok, true);
	assert.equal(seatCount(reg, kA), 2);
	// same nullifier on a different bus is fine
	assert.equal(claimNullifier(reg, '43', 'n1').ok, true);
	// release frees the seat
	assert.equal(releaseNullifier(reg, kA, 'n1'), true);
	assert.equal(seatCount(reg, kA), 1);
	assert.equal(claimNullifier(reg, kA, 'n1').ok, true); // can re-claim after release
});

// A REAL verifier: recompute membership + nullifier from the witness carried on
// the bundle (test-only fields prefixed `_`). This is the genuine algebraic
// check the zk proof attests to — used here so claimSeat is fully exercised
// without the compiled groth16 key.
function realVerifier() {
	return async (b) => {
		const okMembership = await verifyMerkleProof(b._idCommitment, b._pathElements, b._pathIndices, b.merkleRoot);
		const nf = await nullifierFor(b._idSecret, b.busKey);
		return okMembership && nf === toField(b.nullifier);
	};
}

async function makeBundle(identity, tree, index, bus) {
	const w = await buildBusWitness({ identity, tree, index, bus });
	return {
		merkleRoot: w.merkleRoot,
		busKey: w.busKey,
		nullifier: w.nullifier,
		// test-only witness so the real verifier can recompute
		_idSecret: identity.idSecret,
		_idCommitment: identity.idCommitment,
		_pathElements: w.pathElements,
		_pathIndices: w.pathIndices,
	};
}

test('claimSeat: one seat per identity per bus, unlinkable across buses', async () => {
	const ids = [];
	for (let i = 0; i < 3; i++) ids.push(await deriveIdentity({ secret: BigInt(900 + i), salt: 5n }));
	const tree = await buildMerkleTree(ids.map((i) => i.idCommitment));
	const reg = createRegistry();
	const verifyProof = realVerifier();

	// rider 0 boards bus A
	const r0A = await makeBundle(ids[0], tree, 0, BUS_A);
	assert.deepEqual(await claimSeat(reg, r0A, { verifyProof }), { ok: true, reason: null });

	// rider 0 tries to grab a SECOND seat on bus A → rejected (same nullifier)
	const r0A2 = await makeBundle(ids[0], tree, 0, BUS_A);
	assert.equal((await claimSeat(reg, r0A2, { verifyProof })).reason, 'nullifier_used');

	// rider 1 boards bus A → accepted (distinct identity)
	const r1A = await makeBundle(ids[1], tree, 1, BUS_A);
	assert.equal((await claimSeat(reg, r1A, { verifyProof })).ok, true);

	// rider 0 boards bus B → accepted, and the nullifier is unlinkable to bus A
	const r0B = await makeBundle(ids[0], tree, 0, BUS_B);
	assert.equal((await claimSeat(reg, r0B, { verifyProof })).ok, true);
	assert.notEqual(String(r0A.nullifier), String(r0B.nullifier));

	assert.equal(seatCount(reg, r0A.busKey), 2); // rider0 + rider1 on bus A
});

test('claimSeat rejects bad bundles, invalid proofs and unknown roots', async () => {
	const id = await deriveIdentity({ secret: 7n, salt: 7n });
	const tree = await buildMerkleTree([id.idCommitment]);
	const reg = createRegistry();
	const verifyProof = realVerifier();

	assert.equal((await claimSeat(reg, null, { verifyProof })).reason, 'bad_bundle');

	const good = await makeBundle(id, tree, 0, BUS_A);

	// tamper the nullifier so the real verifier recomputes a mismatch
	const forged = { ...good, nullifier: toField(good.nullifier) + 1n };
	assert.equal((await claimSeat(reg, forged, { verifyProof })).reason, 'invalid_proof');

	// pin roots: an unknown root is refused before any proof work
	const acceptRoot = (root) => String(root) === String(tree.root);
	assert.equal((await claimSeat(reg, { ...good, merkleRoot: 12345n }, { verifyProof, acceptRoot })).reason, 'unknown_root');

	// the genuine bundle still passes with root pinning on
	assert.equal((await claimSeat(reg, good, { verifyProof, acceptRoot })).ok, true);
});
