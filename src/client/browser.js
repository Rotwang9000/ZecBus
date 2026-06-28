// ZecBus in-browser proving client (P4c).
//
// Ties the pieces together for a rider proving a seat from the browser, with NO
// secret ever stored:
//   1. derive a reproducible identity from the rider's ANCHOR (e.g. a Zcash
//      viewing key) — see reputation.deriveIdentityFromAnchor;
//   2. rebuild the identity Merkle tree from the coordinator's published leaves
//      and locate the rider's own leaf;
//   3. fetch + cache the circuit artefacts (.wasm / .zkey) by URL;
//   4. generate a groth16 membership proof bound to the bus's published
//      `bus_key`, ready to POST to /v1/zec/bus/join.
//
// Everything is dependency-light and isomorphic: pass your own `fetchImpl` (and,
// in Node, artefact buffers) so it runs in tests without a browser. The heavy
// groth16 work is delegated to generateBusProof (snarkjs) and only runs once
// real ceremony artefacts exist.

import { toField, buildMerkleTree, busKeyFor, deriveIdentityFromAnchor } from '../reputation.js';
import { generateBusProof } from './proof.js';

/**
 * Reproduce the rider's identity from their anchor secret. Deterministic, so it
 * survives reloads without persisting `idSecret`.
 * @param {{ anchor: string, context?: string }} o
 */
export async function deriveRiderIdentity({ anchor, context = 'default' } = {}) {
	return deriveIdentityFromAnchor({ anchor, context });
}

/** Index of a commitment among the published leaves, or -1 (not registered). */
export function findLeafIndex(leaves, idCommitment) {
	const target = toField(idCommitment);
	for (let i = 0; i < leaves.length; i++) {
		if (toField(leaves[i]) === target) return i;
	}
	return -1;
}

// Module-level cache so repeated proofs in one session fetch each artefact once.
const _artifactCache = new Map();

/**
 * Fetch the circuit artefacts as Uint8Arrays, cached by URL. snarkjs accepts
 * these buffers directly for both the wasm witness generator and the .zkey.
 * @param {{ wasmUrl: string, zkeyUrl: string, fetchImpl?: typeof fetch, cache?: boolean }} o
 * @returns {Promise<{ wasm: Uint8Array, zkey: Uint8Array }>}
 */
export async function loadArtifacts({ wasmUrl, zkeyUrl, fetchImpl, cache = true } = {}) {
	if (!wasmUrl || !zkeyUrl) throw new Error('loadArtifacts: wasmUrl and zkeyUrl are required');
	const doFetch = fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null);
	if (!doFetch) throw new Error('loadArtifacts: no fetch available — pass fetchImpl');
	const get = async (url) => {
		if (cache && _artifactCache.has(url)) return _artifactCache.get(url);
		const res = await doFetch(url);
		if (!res || res.ok === false) throw new Error(`loadArtifacts: failed to fetch ${url} (${res?.status ?? '??'})`);
		const buf = new Uint8Array(await res.arrayBuffer());
		if (cache) _artifactCache.set(url, buf);
		return buf;
	};
	const [wasm, zkey] = await Promise.all([get(wasmUrl), get(zkeyUrl)]);
	return { wasm, zkey };
}

/** Forget cached artefacts (e.g. after a circuit/ceremony upgrade). */
export function clearArtifactCache() { _artifactCache.clear(); }

/**
 * Produce a join-ready proof bundle for `bus` (a /v1/zec/bus summary). Derives
 * the identity from the anchor, locates the rider's leaf in the published tree,
 * and proves membership + the per-bus nullifier — binding to the bus's OWN
 * published `bus_key` (and refusing if our recomputation disagrees, which would
 * mean the coordinator and rider disagree on the bus).
 *
 * @param {object} o
 * @param {string} o.anchor                rider's scarce secret (e.g. Zcash UFVK)
 * @param {string} [o.context]             identity domain/epoch separator
 * @param {Array<string|bigint>} o.leaves  coordinator's ordered idCommitments
 * @param {object} o.bus                   bus summary ({ id, from, to, amount_zat, bus_key })
 * @param {Uint8Array|string} o.wasm       witness wasm (buffer or URL)
 * @param {Uint8Array|string} o.zkey       proving key (buffer or URL)
 * @returns {Promise<{ busId: string, proof: object }>} POST body for /join
 */
export async function proveBusSeat({ anchor, context = 'default', leaves, bus, wasm, zkey } = {}) {
	if (!Array.isArray(leaves) || leaves.length === 0) throw new Error('proveBusSeat: leaves (the published identity tree) are required');
	if (!bus || !bus.id) throw new Error('proveBusSeat: a bus summary with an id is required');
	if (!wasm || !zkey) throw new Error('proveBusSeat: wasm and zkey artefacts are required (loadArtifacts)');

	const identity = await deriveRiderIdentity({ anchor, context });
	const index = findLeafIndex(leaves, identity.idCommitment);
	if (index < 0) {
		throw new Error('proveBusSeat: this identity is not in the published tree — register (mint a leaf) first');
	}

	// Bind to the bus the rider actually read. The coordinator publishes bus_key;
	// recompute it locally and refuse on disagreement rather than prove against a
	// key the coordinator won't accept.
	const busKey = busKeyFor(bus).toString();
	if (bus.bus_key != null && String(bus.bus_key) !== busKey) {
		throw new Error(`proveBusSeat: published bus_key (${bus.bus_key}) does not match the recomputed key (${busKey}); refusing to prove`);
	}

	const tree = await buildMerkleTree(leaves);
	const bundle = await generateBusProof({ identity, tree, index, bus, busKey }, { wasmPath: wasm, zkeyPath: zkey });
	return { busId: bus.id, proof: bundle };
}

export default { deriveRiderIdentity, findLeafIndex, loadArtifacts, clearArtifactCache, proveBusSeat };
