// In-browser proving client (P4c) — everything that does NOT need the compiled
// groth16 artefacts (those require a trusted-setup ceremony). The identity
// derivation, leaf lookup, artefact caching and the bus_key binding guard are
// all exercised here; the actual snarkjs proof is covered conceptually by the
// crypto-core membership/nullifier tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveIdentityFromAnchor, busKeyFor } from '../src/reputation.js';
import {
	deriveRiderIdentity,
	findLeafIndex,
	loadArtifacts,
	clearArtifactCache,
	proveBusSeat,
} from '../src/client/browser.js';

const ANCHOR = 'uview1exampleanchorsecret...';
const BUS = { id: 'bus_test', from: 'ZEC.ZEC', to: 'BTC.BTC', amount_zat: 100000000 };

test('deriveRiderIdentity reproduces the anchor identity', async () => {
	const a = await deriveRiderIdentity({ anchor: ANCHOR });
	const b = await deriveIdentityFromAnchor({ anchor: ANCHOR });
	assert.equal(a.idCommitment, b.idCommitment);
});

test('findLeafIndex locates the rider (and reports -1 when absent)', async () => {
	const me = await deriveRiderIdentity({ anchor: ANCHOR });
	const other = await deriveRiderIdentity({ anchor: 'someone-else' });
	const leaves = [123n, other.idCommitment, me.idCommitment].map((x) => x.toString());
	assert.equal(findLeafIndex(leaves, me.idCommitment), 2);
	assert.equal(findLeafIndex(leaves, 999n), -1);
});

test('loadArtifacts fetches once and caches by URL', async () => {
	clearArtifactCache();
	let calls = 0;
	const fetchImpl = async (url) => {
		calls += 1;
		return { ok: true, arrayBuffer: async () => new Uint8Array([url.length]).buffer };
	};
	const a = await loadArtifacts({ wasmUrl: 'http://x/c.wasm', zkeyUrl: 'http://x/c.zkey', fetchImpl });
	assert.ok(a.wasm instanceof Uint8Array && a.zkey instanceof Uint8Array);
	assert.equal(calls, 2);
	await loadArtifacts({ wasmUrl: 'http://x/c.wasm', zkeyUrl: 'http://x/c.zkey', fetchImpl });
	assert.equal(calls, 2, 'second load served from cache');
});

test('loadArtifacts surfaces a clear error on fetch failure', async () => {
	clearArtifactCache();
	const fetchImpl = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
	await assert.rejects(
		() => loadArtifacts({ wasmUrl: 'http://x/missing.wasm', zkeyUrl: 'http://x/c.zkey', fetchImpl }),
		/failed to fetch/
	);
});

test('proveBusSeat refuses when the rider is not registered', async () => {
	const stranger = await deriveRiderIdentity({ anchor: 'not-registered' });
	const leaves = [1n, 2n, 3n].map(String); // stranger absent
	await assert.rejects(
		() => proveBusSeat({ anchor: 'not-registered', leaves, bus: { ...BUS, bus_key: busKeyFor(BUS).toString() }, wasm: new Uint8Array([1]), zkey: new Uint8Array([1]) }),
		/not in the published tree/
	);
	assert.ok(stranger.idCommitment);
});

test('proveBusSeat refuses a bus whose published bus_key disagrees', async () => {
	const me = await deriveRiderIdentity({ anchor: ANCHOR });
	const leaves = [me.idCommitment.toString()];
	await assert.rejects(
		() => proveBusSeat({ anchor: ANCHOR, leaves, bus: { ...BUS, bus_key: '123' }, wasm: new Uint8Array([1]), zkey: new Uint8Array([1]) }),
		/does not match the recomputed key/
	);
});

test('proveBusSeat validates its inputs', async () => {
	await assert.rejects(() => proveBusSeat({ anchor: ANCHOR, leaves: [], bus: BUS, wasm: 1, zkey: 1 }), /leaves/);
	await assert.rejects(() => proveBusSeat({ anchor: ANCHOR, leaves: ['1'], bus: {}, wasm: 1, zkey: 1 }), /bus summary/);
	await assert.rejects(() => proveBusSeat({ anchor: ANCHOR, leaves: ['1'], bus: BUS }), /artefacts/);
});
