const { groth16 } = require('snarkjs');
const { poseidon } = require('circomlibjs');

async function generateProof(viewingKey, salt, txids, busAddresses, publicBusAddresses, numBuses) {
    // Compute commitment
    const commitment = await poseidon([BigInt(viewingKey), BigInt(salt)]);

    // Pad arrays if numBuses < maxBuses
    const maxBuses = 10;
    while (txids.length < maxBuses) txids.push(0);
    while (busAddresses.length < maxBuses) busAddresses.push(0);

    // Input for circuit
    const input = {
        viewing_key: BigInt(viewingKey),
        salt: BigInt(salt),
        txids: txids.map(BigInt),
        bus_addresses: busAddresses.map(BigInt),
        commitment: commitment,
        num_buses: numBuses,
        public_bus_addresses: publicBusAddresses.map(BigInt)
    };

    // Generate proof
    const { proof, publicSignals } = await groth16.fullProve(
        input,
        'reputation.wasm',
        'reputation_final.zkey'
    );

    return { proof, publicSignals };
}

async function submitProof(proof, publicSignals) {
    // Send proof to website (e.g., via POST request or WebSocket)
    const response = await fetch('/api/verify-proof', {
        method: 'POST',
        body: JSON.stringify({ proof, publicSignals })
    });
    return response.json(); // Returns badge status, e.g., "Veteran Rider"
}
