// ZecBus membership-proof generator (P4c). ESM wrapper around snarkjs groth16.
//
// Builds the witness with the shared model (src/reputation.js) so the proof's
// public signals — [merkleRoot, busKey, nullifier] — exactly match what the
// coordinator dedupes on. Needs the compiled circuit artefacts (see
// circuits/build.sh): the .wasm witness generator and the proving .zkey.

import { groth16 } from 'snarkjs';
import { buildBusWitness } from '../reputation.js';

// opts: { wasmPath, zkeyPath }
export async function generateBusProof({ identity, tree, index, bus, busKey }, opts = {}) {
	const { wasmPath, zkeyPath } = opts;
	if (!wasmPath || !zkeyPath) {
		throw new Error('generateBusProof: wasmPath and zkeyPath are required (run circuits/build.sh)');
	}
	const w = await buildBusWitness({ identity, tree, index, bus, busKey });

	const input = {
		idSecret: w.idSecret.toString(),
		idSalt: w.idSalt.toString(),
		pathElements: w.pathElements.map((x) => x.toString()),
		pathIndices: w.pathIndices.map((x) => x.toString()),
		merkleRoot: w.merkleRoot.toString(),
		busKey: w.busKey.toString(),
		nullifier: w.nullifier.toString(),
	};

	const { proof, publicSignals } = await groth16.fullProve(input, wasmPath, zkeyPath);

	// Bundle is exactly what nullifier-registry.claimSeat / the gateway expects.
	return {
		proof,
		publicSignals,
		merkleRoot: w.merkleRoot.toString(),
		busKey: w.busKey.toString(),
		nullifier: w.nullifier.toString(),
	};
}
