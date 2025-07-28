pragma circom 2.1.6;

include "circomlib/poseidon.circom";

template ReputationProof(maxBuses) {
    // Private inputs
    signal input viewing_key;        // Zcash shielded viewing key
    signal input salt;               // Random salt for commitment
    signal input txids[maxBuses];    // Transaction IDs of ZEC sent to buses
    signal input bus_addresses[maxBuses]; // Bus shielded addresses (private to check memo decryption)

    // Public inputs
    signal input commitment;         // hash(viewing_key || salt)
    signal input num_buses;          // Number of successful buses (n)
    signal input public_bus_addresses[maxBuses]; // Public bus addresses for verification

    // Verify commitment
    component poseidon = Poseidon(2);
    poseidon.inputs[0] <== viewing_key;
    poseidon.inputs[1] <== salt;
    commitment === poseidon.out;

    // Verify transactions
    for (var i = 0; i < maxBuses; i++) {
        // Simplified: Check if txids[i] sent ZEC to bus_addresses[i]
        // In practice, this requires Zcash blockchain data to verify memos
        if (i < num_buses) {
            // Placeholder: Verify txids[i] is valid and sent to bus_addresses[i]
            // Matches public_bus_addresses[i] for transparency
            bus_addresses[i] === public_bus_addresses[i];
        } else {
            // Ensure unused slots are zero
            txids[i] === 0;
            bus_addresses[i] === 0;
        }
    }

    // Ensure num_buses is valid
    num_buses <= maxBuses;
}

component main { public [commitment, num_buses, public_bus_addresses] } = ReputationProof(10);
