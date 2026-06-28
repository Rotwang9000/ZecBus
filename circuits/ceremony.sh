#!/usr/bin/env bash
set -euo pipefail

# ZecBus production Groth16 trusted-setup (phase 2), multi-contributor.
#
# build.sh produces a DEV key (one contributor → that contributor can forge
# proofs). For production the proving key must come from a ceremony where
# SEVERAL INDEPENDENT people each add secret entropy and then destroy it: the
# setup is sound as long as *at least one* contributor was honest. This script
# drives that ceremony with snarkjs, one role at a time, so contributors can run
# their step on their own machine and pass only the .zkey between them.
#
# Roles (run in order; hand the produced .zkey to the next person):
#
#   ./ceremony.sh init                      # coordinator: r1cs + ptau -> 0000.zkey
#   ./ceremony.sh contribute <in> <out>     # each participant adds entropy
#   ./ceremony.sh finalize <last> [beaconHex]  # beacon + export + verify
#
# Example with three contributors (files moved between machines):
#   ./ceremony.sh init
#   # -> send reputation_0000.zkey to Alice
#   ./ceremony.sh contribute reputation_0000.zkey reputation_0001.zkey   # Alice
#   ./ceremony.sh contribute reputation_0001.zkey reputation_0002.zkey   # Bob
#   ./ceremony.sh contribute reputation_0002.zkey reputation_0003.zkey   # Carol
#   ./ceremony.sh finalize  reputation_0003.zkey
#
# Each `contribute` PROMPTS for fresh entropy and prints the contribution hash —
# read it aloud / publish it so the chain is publicly attestable. After the
# ceremony, publish: every contribution hash, the final zkey, the verification
# key, and the `zkey verify` transcript. Participants then DELETE their entropy.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CIRC="$ROOT/circuits"
BUILD="$CIRC/build"
R1CS="$BUILD/reputation.r1cs"
PTAU="$BUILD/pot14_final.ptau"
PTAU_URL="https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_14.ptau"
SNARKJS="npx --yes snarkjs"

err() { echo "ERROR: $*" >&2; exit 1; }

ensure_inputs() {
	[ -f "$R1CS" ] || err "missing $R1CS — run circuits/build.sh first to compile the circuit"
	if [ ! -f "$PTAU" ]; then
		echo "== fetching powers of tau =="
		mkdir -p "$BUILD"
		curl -L -o "$PTAU" "$PTAU_URL"
	fi
}

cmd="${1:-}"
case "$cmd" in
	init)
		ensure_inputs
		echo "== groth16 setup (coordinator) =="
		$SNARKJS groth16 setup "$R1CS" "$PTAU" "$BUILD/reputation_0000.zkey"
		echo ""
		echo "Created $BUILD/reputation_0000.zkey"
		echo "Send it to the first contributor, who runs: ./ceremony.sh contribute reputation_0000.zkey reputation_0001.zkey"
		;;
	contribute)
		IN="${2:-}"; OUT="${3:-}"
		[ -n "$IN" ] && [ -n "$OUT" ] || err "usage: ./ceremony.sh contribute <in.zkey> <out.zkey>"
		[ -f "$IN" ] || err "input zkey not found: $IN"
		NAME="${CONTRIBUTOR_NAME:-contributor-$(date +%Y%m%d%H%M%S)}"
		echo "== phase-2 contribution: $NAME =="
		echo "You will be prompted for random text. Type a long, unpredictable string."
		echo "snarkjs also mixes in OS entropy. Your entropy MUST be destroyed afterwards."
		# Interactive: snarkjs prompts for entropy when --entropy is omitted.
		$SNARKJS zkey contribute "$IN" "$OUT" --name="$NAME" -v
		echo ""
		echo "Done. Publish the contribution hash printed above, then send $OUT to the next contributor"
		echo "(or run ./ceremony.sh finalize $OUT if you are the last)."
		;;
	finalize)
		ensure_inputs
		LAST="${2:-}"
		[ -n "$LAST" ] && [ -f "$LAST" ] || err "usage: ./ceremony.sh finalize <last.zkey> [beaconHex]"
		# A public random beacon caps the chain so no contributor was 'last' with
		# a held-back contribution. Default: a clearly-labelled placeholder — for a
		# real ceremony pass a genuine public beacon (e.g. a future Bitcoin/Zcash
		# block hash agreed in advance).
		BEACON="${3:-0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20}"
		echo "== apply random beacon =="
		$SNARKJS zkey beacon "$LAST" "$BUILD/reputation_final.zkey" "$BEACON" 10 -n="final beacon"
		echo "== verify the whole chain against r1cs + ptau =="
		$SNARKJS zkey verify "$R1CS" "$PTAU" "$BUILD/reputation_final.zkey"
		echo "== export verification key =="
		$SNARKJS zkey export verificationkey "$BUILD/reputation_final.zkey" "$BUILD/verification_key.json"
		echo ""
		echo "Production artefacts in $BUILD:"
		echo "  reputation_final.zkey       (proving key — ship to the prover/site)"
		echo "  verification_key.json       (ship to the coordinator/gateway)"
		echo "Publish: all contribution hashes, the beacon value, and the verify transcript above."
		;;
	*)
		err "unknown role '$cmd'. Use: init | contribute <in> <out> | finalize <last> [beaconHex]"
		;;
esac
