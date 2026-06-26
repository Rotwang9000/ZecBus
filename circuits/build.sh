#!/usr/bin/env bash
set -euo pipefail

# Compile reputation.circom and run a Groth16 setup.
#
# Requirements (not bundled — install once):
#   - circom 2.x on PATH         (https://docs.circom.io/getting-started/installation/)
#   - npm deps installed         (npm install — pulls snarkjs + circomlib)
#   - a Powers-of-Tau file       (downloaded below if missing)
#
# ┌─ SECURITY ───────────────────────────────────────────────────────────────┐
# │ The `groth16 setup` + single `zkey contribute` here is a DEVELOPMENT      │
# │ setup: one contributor means that contributor could forge proofs. The     │
# │ production verification_key.json / .zkey MUST come from a multi-party     │
# │ trusted-setup ceremony (several independent contributors). DO NOT ship    │
# │ the dev .zkey produced by this script.                                    │
# └────────────────────────────────────────────────────────────────────────┘

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CIRC="$ROOT/circuits"
BUILD="$CIRC/build"
PTAU="$BUILD/pot14_final.ptau"           # 2^14 supports the ~5k-constraint circuit
PTAU_URL="https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_14.ptau"

mkdir -p "$BUILD"
command -v circom >/dev/null || { echo "ERROR: circom not on PATH"; exit 1; }
SNARKJS="npx --yes snarkjs"

echo "== compile =="
# -l node_modules so `include "circomlib/circuits/..."` resolves.
circom "$CIRC/reputation.circom" --r1cs --wasm --sym -o "$BUILD" -l "$ROOT/node_modules"

echo "== powers of tau =="
[ -f "$PTAU" ] || curl -L -o "$PTAU" "$PTAU_URL"

echo "== groth16 setup (DEV — replace with a ceremony zkey for production) =="
$SNARKJS groth16 setup "$BUILD/reputation.r1cs" "$PTAU" "$BUILD/reputation_0000.zkey"
echo "zecbus-dev-$(date +%s)" | $SNARKJS zkey contribute \
	"$BUILD/reputation_0000.zkey" "$BUILD/reputation_final.zkey" --name="dev" -v
$SNARKJS zkey export verificationkey "$BUILD/reputation_final.zkey" "$BUILD/verification_key.json"

echo ""
echo "Artefacts in $BUILD:"
echo "  reputation_js/reputation.wasm   (prover witness generator)"
echo "  reputation_final.zkey           (DEV proving key — do not ship)"
echo "  verification_key.json           (coordinator verifies against this)"
