pragma circom 2.1.6;

// ZecBus sybil-resistance circuit (v2, non-custodial).
//
// Proves, in zero knowledge, that the prover:
//   1. knows a secret behind a committed identity  idCommitment = Poseidon(idSecret, idSalt)
//   2. that identity is a leaf in the identity Merkle tree with root `merkleRoot`
//   3. and the revealed `nullifier = Poseidon(idSecret, busKey)` is that
//      identity's unique, deterministic tag for this specific bus.
//
// Public:  merkleRoot, busKey, nullifier
// Private: idSecret, idSalt, pathElements[depth], pathIndices[depth]
//
// The coordinator learns only the nullifier (one per identity per bus, so it
// can reject a second seat) — never which identity, and the same identity is
// unlinkable across different buses (different busKey ⇒ different nullifier).
//
// Every relation matches src/reputation.js (the witness builder / spec):
//   leaf  = Poseidon(idSecret, idSalt)
//   node  = Poseidon(left, right)          (left = lower index)
//   path  : pathIndices[i] == 1  ⇒ current node is the RIGHT child
//   nullf = Poseidon(idSecret, busKey)

include "circomlib/circuits/poseidon.circom";

// One Merkle step: hash `cur` with its sibling in the order given by `pathIndex`.
template MerkleLevel() {
    signal input cur;
    signal input pathElement;
    signal input pathIndex; // boolean: 1 ⇒ cur is the right child
    signal output out;

    // constrain pathIndex ∈ {0,1}
    pathIndex * (pathIndex - 1) === 0;

    // left  = pathIndex==1 ? pathElement : cur
    // right = pathIndex==1 ? cur         : pathElement
    signal left;
    signal right;
    left  <== cur + pathIndex * (pathElement - cur);
    right <== pathElement + pathIndex * (cur - pathElement);

    component h = Poseidon(2);
    h.inputs[0] <== left;
    h.inputs[1] <== right;
    out <== h.out;
}

template BusMembership(depth) {
    // private
    signal input idSecret;
    signal input idSalt;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    // public
    signal input merkleRoot;
    signal input busKey;
    signal input nullifier;

    // idCommitment = Poseidon(idSecret, idSalt)
    component idc = Poseidon(2);
    idc.inputs[0] <== idSecret;
    idc.inputs[1] <== idSalt;

    // Merkle membership: fold from the leaf up to the root.
    component levels[depth];
    signal cur[depth + 1];
    cur[0] <== idc.out;
    for (var i = 0; i < depth; i++) {
        levels[i] = MerkleLevel();
        levels[i].cur <== cur[i];
        levels[i].pathElement <== pathElements[i];
        levels[i].pathIndex <== pathIndices[i];
        cur[i + 1] <== levels[i].out;
    }
    merkleRoot === cur[depth];

    // nullifier = Poseidon(idSecret, busKey)
    component nf = Poseidon(2);
    nf.inputs[0] <== idSecret;
    nf.inputs[1] <== busKey;
    nullifier === nf.out;
}

// depth 20 ⇒ up to ~1.05M registered identities. Keep in sync with
// DEFAULT_TREE_DEPTH in src/reputation.js.
component main { public [merkleRoot, busKey, nullifier] } = BusMembership(20);
