const { groth16 } = require('snarkjs');

async function verifyProof(proof, publicSignals) {
    const verificationKey = require('../circuits/verification_key.json');
    const isValid = await groth16.verify(verificationKey, publicSignals, proof);

    if (isValid) {
        const numBuses = publicSignals[1]; // Second signal is num_buses
        if (numBuses >= 5) return 'Veteran Rider';
        if (numBuses >= 3) return 'Regular Rider';
        if (numBuses >= 1) return 'New Rider';
    }
    return 'No Badge';
}
