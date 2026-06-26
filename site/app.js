// ZecBus standalone site — talks directly to the winbit32 gateway's free,
// non-custodial bus-coordination REST surface. No build step, no framework,
// nothing persisted: the one-time seat token lives in memory (and is shown
// with a Copy button so you can save it yourself and resume later).

const API_BASE = 'https://mcp.winbit32.com';
const BUS_BASE = `${API_BASE}/v1/zec/bus`;
const POPULAR_URL = `${API_BASE}/v1/zec/popular-amounts?side=deshield&limit=24`;
const MCP_URL = `${API_BASE}/mcp`;
const POLL_MS = 12000;
const ZATS = 1e8;

// Exit assets (CHAIN.TICKER). The point of the bus is leaving ZEC, so the
// source is always ZEC; these are the destinations a rider can swap to.
const EXIT_ASSETS = [
	{ id: 'BTC.BTC', label: 'Bitcoin (BTC)' },
	{ id: 'ETH.ETH', label: 'Ethereum (ETH)' },
	{ id: 'THOR.RUNE', label: 'THORChain (RUNE)' },
	{ id: 'LTC.LTC', label: 'Litecoin (LTC)' },
	{ id: 'BCH.BCH', label: 'Bitcoin Cash (BCH)' },
	{ id: 'DASH.DASH', label: 'Dash (DASH)' },
];

const STATUS_LABEL = { boarding: 'Boarding', ready: 'Ready', departed: 'Departed', expired: 'Expired', cancelled: 'Cancelled' };

// ── tiny DOM helpers ────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k === 'html') node.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
		else if (v !== null && v !== undefined) node.setAttribute(k, v);
	}
	for (const kid of kids) if (kid != null) node.append(kid);
	return node;
};

// ── never-throwing fetch envelope ──────────────────────────────────
async function api(url, { method = 'GET', body = null } = {}) {
	let res;
	try {
		res = await fetch(url, {
			method,
			headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	} catch (e) {
		return { ok: false, status: null, data: null, reason: 'unreachable' };
	}
	let data = null;
	try { data = JSON.parse(await res.text()); } catch { data = null; }
	if (res.status === 503) return { ok: false, status: 503, data, reason: 'disabled', error: data?.error };
	if (!res.ok) return { ok: false, status: res.status, data, reason: 'http_error', error: data?.error };
	return { ok: true, status: res.status, data };
}

const listBuses = (to) => api(`${BUS_BASE}${to ? `?to=${encodeURIComponent(to)}` : ''}`);
const getBus = (id, seatId, token) => api(`${BUS_BASE}/${encodeURIComponent(id)}?seatId=${encodeURIComponent(seatId)}&ownerToken=${encodeURIComponent(token)}`);
const joinBus = (b) => api(`${BUS_BASE}/join`, { method: 'POST', body: b });
const seatAction = (seatId, action, token) => api(`${BUS_BASE}/seat/${encodeURIComponent(seatId)}/${action}`, { method: 'POST', body: { ownerToken: token } });

// ── state ───────────────────────────────────────────────────────────
const state = {
	buses: [],
	caveats: [],
	blendZats: new Set(),
	blend: [],
	mySeat: null, // { seat, bus, ownerToken }
	busy: false,
	disabled: false,
};

// ── rendering ───────────────────────────────────────────────────────
function fmtAmount(zec) {
	return Number(zec).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function busCard(bus) {
	const mine = state.mySeat?.bus?.id === bus.id;
	const card = el('li', { class: `bus${mine ? ' bus--mine' : ''}` });
	card.append(
		el('div', { class: 'bus__top' },
			el('span', { class: 'bus__route', text: `${bus.from} → ${bus.to}` }),
			el('span', { class: `pill pill--${bus.status}`, text: STATUS_LABEL[bus.status] || bus.status }),
		),
		el('div', { class: 'bus__amount', html: `${fmtAmount(bus.amount_zec)} <small>ZEC</small>` }),
		el('div', { class: 'bus__seats', html: `<b>${bus.seats_filled}/${bus.min_passengers}</b> seats${bus.seats_departed ? ` · ${bus.seats_departed} away` : ''}` }),
	);
	if (bus.privacy?.headline) card.append(el('div', { class: `bus__priv bus__priv--${bus.privacy.level}`, text: bus.privacy.headline }));
	if (mine) card.append(el('div', { class: 'bus__priv', text: 'This is your bus.' }));
	else if (bus.status === 'boarding') {
		card.append(el('button', {
			class: 'btn btn--primary', text: 'Board this bus',
			onclick: () => reserve({ to: bus.to, amount: bus.amount_zec, minPassengers: bus.min_passengers }),
		}));
	}
	return card;
}

function renderBoard() {
	const list = $('bus-list');
	list.replaceChildren();
	if (state.disabled) { $('board-status').textContent = 'The bus board is not enabled on the gateway right now.'; return; }
	if (!state.buses.length) {
		$('board-status').textContent = 'No buses boarding right now — start one below and others can hop on.';
		return;
	}
	$('board-status').textContent = `${state.buses.length} bus${state.buses.length === 1 ? '' : 'es'} open.`;
	for (const b of state.buses) list.append(busCard(b));
}

function renderCaveats() {
	const ul = $('caveats-list');
	ul.replaceChildren();
	for (const c of state.caveats) ul.append(el('li', { text: c }));
}

function renderChips() {
	const ul = $('amount-chips');
	ul.replaceChildren();
	for (const a of state.blend.slice(0, 12)) {
		const on = Math.round(Number($('join-amount').value) * ZATS) === a.zats;
		ul.append(el('li', {}, el('button', {
			class: `chip${on ? ' chip--on' : ''}`, type: 'button',
			onclick: () => { $('join-amount').value = String(a.zec); onAmountInput(); },
			html: `${fmtAmount(a.zec)}${a.count ? ` <small>·${a.count}</small>` : ''}`,
		})));
	}
}

function renderSeat() {
	const card = $('seat-card');
	const joinCard = $('join-card');
	if (!state.mySeat?.seat) { card.hidden = true; joinCard.hidden = false; return; }
	card.hidden = false; joinCard.hidden = true;

	const { seat, bus, ownerToken } = state.mySeat;
	const summary = $('seat-summary');
	summary.replaceChildren(
		el('span', { class: 'bus__route', text: `${bus.from} → ${bus.to}` }),
		el('span', { class: 'bus__amount', html: `${fmtAmount(bus.amount_zec)} <small>ZEC</small>` }),
		el('span', { class: `pill pill--${bus.status}`, text: STATUS_LABEL[bus.status] || bus.status }),
		el('span', { class: 'seat-hint', text: `your seat: ${seat.status}` }),
	);
	if (bus.privacy?.headline) summary.append(el('div', { class: `bus__priv bus__priv--${bus.privacy.level}`, text: bus.privacy.headline }));

	// One-time token (only when we just received it on join).
	const tokenBox = $('token-box');
	if (ownerToken) { tokenBox.hidden = false; $('token-value').value = ownerToken; }
	else tokenBox.hidden = true;

	const actions = $('seat-actions');
	actions.replaceChildren();
	const ready = bus.status === 'ready';
	if (ready) {
		actions.append(el('a', {
			class: 'btn btn--primary', href: 'https://winbit32.com', target: '_blank', rel: 'noopener',
			text: `Broadcast your ${bus.from.split('.')[0]}→${bus.to.split('.')[0]} swap ▶`,
		}));
		actions.append(el('span', { class: 'seat-hint', text: `Swap ${fmtAmount(bus.amount_zec)} ZEC to ${bus.to} now, during the window, to a fresh destination. (One-click broadcast is coming inside WINBIT32.)` }));
	}
	if (seat.status === 'reserved') {
		actions.append(el('button', { class: 'btn', text: 'Confirm boarded', onclick: () => doSeat('board') }));
	}
	actions.append(el('button', { class: 'btn btn--leave', text: 'Leave seat', onclick: () => doSeat('leave') }));
}

// ── actions ─────────────────────────────────────────────────────────
function setBusy(v) { state.busy = v; $('join-go').disabled = v || !canReserve(); }

function canReserve() {
	const zec = Number($('join-amount').value);
	if (!Number.isFinite(zec) || zec <= 0) return false;
	return state.blendZats.size === 0 ? true : state.blendZats.has(Math.round(zec * ZATS));
}

function onAmountInput() {
	const zec = Number($('join-amount').value);
	const hint = $('amount-hint');
	if (Number.isFinite(zec) && zec > 0 && state.blendZats.size && !state.blendZats.has(Math.round(zec * ZATS))) {
		hint.textContent = "That isn't a common blend-in amount — pick one below so a bus of identical odd amounts isn't just a shared fingerprint.";
	} else hint.textContent = '';
	$('join-go').disabled = state.busy || !canReserve();
	renderChips();
}

async function reserve({ to, amount, minPassengers, handle }) {
	if (state.busy) return;
	setBusy(true);
	const res = await joinBus({ to, amount, minPassengers, handle: handle || undefined });
	if (res.ok && res.data) {
		state.mySeat = { seat: res.data.seat, bus: res.data.bus, ownerToken: res.data.owner_token };
		if (Array.isArray(res.data.caveats)) { state.caveats = res.data.caveats; renderCaveats(); }
		renderSeat();
		refresh();
	} else {
		$('amount-hint').textContent = res.error?.message || (res.reason === 'disabled' ? 'The bus board is not enabled right now.' : 'Could not reserve a seat — try again.');
	}
	setBusy(false);
}

async function doSeat(action) {
	const s = state.mySeat;
	if (!s?.seat?.id) return;
	const res = await seatAction(s.seat.id, action, s.ownerToken);
	if (res.ok && res.data) {
		if (action === 'leave') { state.mySeat = null; renderSeat(); refresh(); return; }
		state.mySeat = { ...s, seat: res.data.seat || s.seat, bus: res.data.bus || s.bus };
		renderSeat();
	} else {
		alert(res.error?.message || `Could not ${action} the seat.`);
	}
}

async function resumeSeat() {
	const seatId = $('resume-seat').value.trim();
	const token = $('resume-token').value.trim();
	if (!seatId || !token) return;
	// We don't know the bus id; ask the seat's bus via a probe join? No — use
	// status: the seat view needs the bus id, so walk the open list to find it,
	// else accept and let the next poll resolve it once it appears.
	const lists = await listBuses();
	let found = null;
	if (lists.ok) {
		for (const b of lists.data.buses || []) {
			const one = await getBus(b.id, seatId, token);
			if (one.ok && one.data?.seat) { found = { seat: one.data.seat, bus: one.data.bus, ownerToken: null }; break; }
		}
	}
	if (found) { state.mySeat = found; renderSeat(); $('resume-box').hidden = true; }
	else $('amount-hint').textContent = 'Could not find that seat on an open bus (it may have departed or expired).';
}

// ── polling ─────────────────────────────────────────────────────────
async function refresh() {
	const to = $('filter-to').value;
	const res = await listBuses(to);
	if (res.reason === 'disabled') { state.disabled = true; renderBoard(); return; }
	state.disabled = false;
	if (res.ok && res.data) {
		state.buses = Array.isArray(res.data.buses) ? res.data.buses : [];
		if (Array.isArray(res.data.caveats) && res.data.caveats.length) { state.caveats = res.data.caveats; renderCaveats(); }
	}
	renderBoard();

	const s = state.mySeat;
	if (s?.seat?.id && s?.bus?.id) {
		const one = await getBus(s.bus.id, s.seat.id, s.ownerToken || '');
		if (one.ok && one.data?.bus) {
			state.mySeat = { ...s, bus: one.data.bus, seat: one.data.seat || s.seat };
			renderSeat();
		}
	}
}

async function loadBlend() {
	const res = await api(POPULAR_URL);
	if (res.ok && Array.isArray(res.data?.amounts)) {
		state.blend = res.data.amounts.map((a) => ({ zec: a.zec, zats: a.zats ?? Math.round(a.zec * ZATS), count: a.count }));
		state.blendZats = new Set(state.blend.map((a) => a.zats));
		renderChips();
		onAmountInput();
	}
}

// ── init ────────────────────────────────────────────────────────────
function fillAssetSelects() {
	const filter = $('filter-to');
	const join = $('join-to');
	for (const a of EXIT_ASSETS) {
		filter.append(el('option', { value: a.id, text: a.label }));
		join.append(el('option', { value: a.id, text: a.label }));
	}
	join.value = 'BTC.BTC';
}

function renderMcpConfig() {
	$('mcp-config').textContent = JSON.stringify({ mcpServers: { winbit32: { url: MCP_URL } } }, null, 2);
}

function wireEvents() {
	$('refresh').addEventListener('click', refresh);
	$('filter-to').addEventListener('change', refresh);
	$('join-amount').addEventListener('input', onAmountInput);
	$('join-go').addEventListener('click', () => reserve({
		to: $('join-to').value,
		amount: Number($('join-amount').value),
		minPassengers: Number($('join-min').value) || 5,
		handle: $('join-handle').value.trim(),
	}));
	$('token-copy').addEventListener('click', () => navigator.clipboard?.writeText($('token-value').value));
	$('resume-toggle').addEventListener('click', () => { $('resume-box').hidden = !$('resume-box').hidden; });
	$('resume-go').addEventListener('click', resumeSeat);
}

fillAssetSelects();
renderMcpConfig();
wireEvents();
loadBlend();
refresh();
setInterval(refresh, POLL_MS);
