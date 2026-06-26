// ZecBus membership-proof verifier (P4c). Coordinator-side: verify a rider's
// groth16 proof and bind its public signals to the claimed seat bundle.
//
// Public signal order matches `component main { public [merkleRoot, busKey,
// nullifier] }` in circuits/reputation.circom.

import { groth16 } from 'snarkjs';

export function publicSignalsToBundle(publicSignals) {
	const [merkleRoot, busKey, nullifier] = publicSignals;
	return { merkleRoot, busKey, nullifier };
}

export async function verifyBusProof(verificationKey, { proof, publicSignals }) {
	return groth16.verify(verificationKey, publicSignals, proof);
}

// Returns a verifier fn for nullifier-registry.claimSeat: it both checks the
// proof and asserts the proof's public signals equal the bundle's claimed
// merkleRoot/busKey/nullifier (so a valid proof can't be replayed against a
// different nullifier/bus).
export function makeProofVerifier(verificationKey) {
	return async function verify(bundle) {
		if (!bundle || !bundle.proof || !Array.isArray(bundle.publicSignals)) return false;
		const ok = await groth16.verify(verificationKey, bundle.publicSignals, bundle.proof);
		if (!ok) return false;
		const sig = publicSignalsToBundle(bundle.publicSignals);
		return (
			String(sig.merkleRoot) === String(bundle.merkleRoot) &&
			String(sig.busKey) === String(bundle.busKey) &&
			String(sig.nullifier) === String(bundle.nullifier)
		);
	};
}
