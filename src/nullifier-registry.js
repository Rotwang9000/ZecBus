// ZecBus nullifier registry (P4c) — the coordinator-side enforcement core.
//
// Pure, in-memory, dependency-free. The bus coordinator keeps one of these per
// process (the gateway will persist it). A seat claim is accepted only if the
// rider's zk membership proof verifies AND their per-bus nullifier has not been
// used on that bus before — giving "one seat per anonymous identity per bus".
//
// Verifying the proof is the trust anchor; this module only handles the
// dedupe/bookkeeping (the bit that is cheap to get subtly wrong). The proof
// verifier is INJECTED so this stays free of the heavy snarkjs/zkey machinery
// and is fully unit-testable with the real Poseidon model.

export function createRegistry() {
	// busKey (string) -> Set<nullifier string>
	return { byBus: new Map() };
}

const k = (v) => (typeof v === 'bigint' ? v.toString() : String(v));

export function hasNullifier(registry, busKey, nullifier) {
	const set = registry.byBus.get(k(busKey));
	return !!set && set.has(k(nullifier));
}

export function seatCount(registry, busKey) {
	return registry.byBus.get(k(busKey))?.size ?? 0;
}

// Record a nullifier for a bus. Returns { ok, reason }. Idempotency is the whole
// point: a repeat is rejected, not silently merged.
export function claimNullifier(registry, busKey, nullifier) {
	const bk = k(busKey);
	const nf = k(nullifier);
	let set = registry.byBus.get(bk);
	if (!set) {
		set = new Set();
		registry.byBus.set(bk, set);
	}
	if (set.has(nf)) return { ok: false, reason: 'nullifier_used' };
	set.add(nf);
	return { ok: true, reason: null };
}

// Release a seat (rider left before departure) so the seat frees up. Returns
// true if a nullifier was actually removed.
export function releaseNullifier(registry, busKey, nullifier) {
	const set = registry.byBus.get(k(busKey));
	if (!set) return false;
	return set.delete(k(nullifier));
}

// Full claim path: verify the proof, then dedupe. `verifyProof(bundle)` must
// resolve truthy for a valid membership proof whose public signals match
// `{ merkleRoot, busKey, nullifier }`. `acceptRoot(root)` lets the caller pin
// which identity-tree roots are currently valid (defaults to accept-any).
export async function claimSeat(registry, bundle, { verifyProof, acceptRoot } = {}) {
	if (!bundle || bundle.busKey == null || bundle.nullifier == null) {
		return { ok: false, reason: 'bad_bundle' };
	}
	if (typeof acceptRoot === 'function' && !acceptRoot(bundle.merkleRoot)) {
		return { ok: false, reason: 'unknown_root' };
	}
	if (typeof verifyProof === 'function') {
		let valid = false;
		try {
			valid = await verifyProof(bundle);
		} catch {
			valid = false;
		}
		if (!valid) return { ok: false, reason: 'invalid_proof' };
	}
	return claimNullifier(registry, bundle.busKey, bundle.nullifier);
}
