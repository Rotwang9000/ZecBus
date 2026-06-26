// ZecBus Station — talks directly to the winbit32 gateway's free, non-custodial
// bus-coordination REST surface. No build step, no framework, nothing persisted:
// the one-time seat token lives in memory (shown with a Copy button so you can
// save it yourself and resume later).

const API_BASE = 'https://mcp.winbit32.com';
const BUS_BASE = `${API_BASE}/v1/zec/bus`;
const POPULAR_URL = `${API_BASE}/v1/zec/popular-amounts?side=deshield&limit=24`;
const MCP_URL = `${API_BASE}/mcp`;
const POLL_MS = 12000;
const ZATS = 1e8;
const MAX_BOARD_ROWS = 10;

// Exit assets (CHAIN.TICKER). The bus is always about *leaving* ZEC, so the
// source is fixed; these are the destinations a rider can swap out to.
const EXIT_ASSETS = [
	{ id: 'BTC.BTC', label: 'Bitcoin', short: 'BTC' },
	{ id: 'ETH.ETH', label: 'Ethereum', short: 'ETH' },
	{ id: 'THOR.RUNE', label: 'THORChain', short: 'RUNE' },
	{ id: 'LTC.LTC', label: 'Litecoin', short: 'LTC' },
	{ id: 'BCH.BCH', label: 'Bitcoin Cash', short: 'BCH' },
	{ id: 'DASH.DASH', label: 'Dash', short: 'DASH' },
];

// Routes/amounts surfaced as "scheduled" departures so the board always looks
// alive. These are real, joinable routes (0 seats) — clearly marked Scheduled.
const SUGGEST_DESTS = ['BTC.BTC', 'ETH.ETH', 'THOR.RUNE'];
const HEADLINE_AMOUNTS = [0.1, 0.5, 1, 2, 5, 10];

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
const shortOf = (id) => EXIT_ASSETS.find((a) => a.id === id)?.short || String(id || '').split('.').pop() || id;
const nameOf = (id) => EXIT_ASSETS.find((a) => a.id === id)?.label || shortOf(id);
const toZats = (zec) => Math.round(Number(zec) * ZATS);
const fmtAmount = (zec) => Number(zec).toLocaleString(undefined, { maximumFractionDigits: 8 });

// ── never-throwing fetch envelope ──────────────────────────────────
async function api(url, { method = 'GET', body = null } = {}) {
	let res;
	try {
		res = await fetch(url, {
			method,
			headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	} catch {
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
	stats: null,
	caveats: [],
	blendZats: new Set(),
	blend: [],
	mySeat: null, // { seat, bus, ownerToken }
	busy: false,
	disabled: false,
};

// ── live clock (UTC) ────────────────────────────────────────────────
function tickClock() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, '0');
	$('board-clock').textContent = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

// ── stats strip ─────────────────────────────────────────────────────
function setStat(id, value) {
	const node = $(id);
	const next = String(value);
	if (node.textContent === next) return;
	node.textContent = next;
	node.classList.remove('flap');           // restart the flip animation
	void node.offsetWidth;                    // force reflow
	node.classList.add('flap');
}

function renderStats() {
	const live = state.buses;
	const s = state.stats || {};
	const boarding = s?.buses?.boarding ?? live.filter((b) => b.status === 'boarding').length;
	const ready = s?.buses?.ready ?? live.filter((b) => b.status === 'ready').length;
	const seats = s?.seats_total ?? live.reduce((n, b) => n + (b.seats_filled || 0), 0);
	const routes = new Set(live.map((b) => b.to)).size;
	setStat('stat-boarding', boarding);
	setStat('stat-ready', ready);
	setStat('stat-seats', seats);
	setStat('stat-routes', routes);
	setStat('stat-amounts', state.blend.length || HEADLINE_AMOUNTS.length);
}

// ── ticker ──────────────────────────────────────────────────────────
function renderTicker() {
	const parts = [];
	if (state.buses.length) {
		for (const b of state.buses.slice(0, 6)) {
			const tag = b.status === 'ready' ? 'window open' : `${Math.max(0, (b.min_passengers || 0) - (b.seats_filled || 0))} more to fill`;
			parts.push(`${b.status === 'ready' ? '▶' : '●'} ${fmtAmount(b.amount_zec)} ZEC → ${shortOf(b.to)} · ${b.seats_filled}/${b.min_passengers} · ${tag}`);
		}
	} else {
		parts.push('● Board is clear — start a departure and others will hop on');
	}
	const amts = (state.blend.length ? state.blend : HEADLINE_AMOUNTS.map((z) => ({ zec: z }))).slice(0, 9).map((a) => fmtAmount(a.zec)).join(' · ');
	parts.push(`Blend-in amounts: ${amts} ZEC`);
	parts.push('Non-custodial — you broadcast your own swap, ZecBus never holds funds or keys');
	parts.push('Idea + stats from zecstats.com');

	const copy = parts.map((t) => `<span class="seg">${t}</span><span class="sep">✦</span>`).join('');
	$('ticker-track').innerHTML = copy + copy; // duplicate for a seamless -50% loop
}

// ── the departures board ────────────────────────────────────────────
function statusCell(status, detail) {
	const map = { boarding: 'boarding', ready: 'ready', departed: 'departing', scheduled: 'scheduled' };
	const cls = map[status] || 'scheduled';
	const label = status === 'scheduled' ? 'Scheduled' : (STATUS_LABEL[status] || status);
	const span = el('span', { class: `status status--${cls}`, text: label });
	if (detail) span.append(el('small', { text: ` ${detail}` }));
	return span;
}

function liveRow(bus) {
	const mine = state.mySeat?.bus?.id === bus.id;
	const ready = bus.status === 'ready';
	const tr = el('tr', { class: `is-${ready ? 'ready' : 'live'}` });

	tr.append(
		el('td', { class: 'c-dest' },
			el('span', { class: 'dest flap' }, shortOf(bus.to), el('small', { text: `from ${shortOf(bus.from)}` }))),
		el('td', { class: 'c-amt' },
			el('span', { class: 'amt flap', html: `${fmtAmount(bus.amount_zec)} <small>ZEC</small>` })),
		el('td', { class: 'c-seats' },
			el('span', { class: 'seats', html: `<b>${bus.seats_filled}</b>/${bus.min_passengers}${bus.seats_departed ? ` <small>· ${bus.seats_departed} away</small>` : ''}` })),
		el('td', { class: 'c-status' },
			statusCell(bus.status, ready ? 'window open' : `${Math.max(0, (bus.min_passengers || 0) - (bus.seats_filled || 0))} to go`)),
	);

	const act = el('td', { class: 'c-act' });
	if (mine) act.append(el('span', { class: 'status--ready status', text: 'Your seat' }));
	else if (bus.status === 'boarding' || (ready && bus.seats_filled < bus.seats_max)) {
		act.append(el('button', {
			class: 'btn btn--board btn--sm', text: 'Board',
			onclick: () => reserve({ to: bus.to, amount: bus.amount_zec, minPassengers: bus.min_passengers }),
		}));
	}
	tr.append(act);
	return tr;
}

function scheduledRow(to, zec) {
	const tr = el('tr', { class: 'is-sched' });
	tr.append(
		el('td', { class: 'c-dest' },
			el('span', { class: 'dest' }, shortOf(to), el('small', { text: `from ZEC` }))),
		el('td', { class: 'c-amt' },
			el('span', { class: 'amt', html: `${fmtAmount(zec)} <small>ZEC</small>` })),
		el('td', { class: 'c-seats' },
			el('span', { class: 'seats', html: `<b>0</b>/5 <small>· open</small>` })),
		el('td', { class: 'c-status' }, statusCell('scheduled', 'be the first')),
		el('td', { class: 'c-act' },
			el('button', {
				class: 'btn btn--sched btn--sm', text: 'Start',
				onclick: () => prefillJoin(to, zec),
			})),
	);
	return tr;
}

function scheduledRoutes(slots) {
	if (slots <= 0) return [];
	const filter = $('filter-to').value;
	const dests = filter ? [filter] : SUGGEST_DESTS;
	const amounts = state.blendZats.size
		? HEADLINE_AMOUNTS.filter((z) => state.blendZats.has(toZats(z)))
		: HEADLINE_AMOUNTS;
	const liveKeys = new Set(state.buses.map((b) => `${b.to}@${toZats(b.amount_zec)}`));
	const out = [];
	for (const z of amounts) {
		for (const d of dests) {
			if (out.length >= slots) return out;
			if (liveKeys.has(`${d}@${toZats(z)}`)) continue;
			out.push({ to: d, zec: z });
		}
	}
	return out;
}

function renderBoard() {
	const body = $('board-rows');
	body.replaceChildren();

	if (state.disabled) {
		$('board-status').textContent = 'The bus board is not enabled on the gateway right now.';
		return;
	}

	const live = [...state.buses].sort((a, b) => {
		const rank = (x) => (x.status === 'ready' ? 0 : x.status === 'boarding' ? 1 : 2);
		return rank(a) - rank(b) || (b.seats_filled || 0) - (a.seats_filled || 0);
	});
	for (const b of live) body.append(liveRow(b));

	const sched = scheduledRoutes(MAX_BOARD_ROWS - live.length);
	for (const r of sched) body.append(scheduledRow(r.to, r.zec));

	if (live.length) {
		$('board-status').textContent = `${live.length} live ${live.length === 1 ? 'departure' : 'departures'} · ${sched.length} scheduled — board any of them.`;
	} else {
		$('board-status').textContent = 'No live buses yet — these routes are ready to open. Be the first and others will hop on.';
	}
}

// ── amount chips + form ─────────────────────────────────────────────
function renderChips() {
	const ul = $('amount-chips');
	ul.replaceChildren();
	const cur = toZats($('join-amount').value);
	for (const a of state.blend.slice(0, 12)) {
		ul.append(el('li', {
			class: cur === a.zats ? 'is-on' : '',
			onclick: () => { $('join-amount').value = String(a.zec); onAmountInput(); },
			html: `${fmtAmount(a.zec)}${a.count ? ` <small>·${a.count}</small>` : ''}`,
		}));
	}
}

function prefillJoin(to, zec) {
	$('join-to').value = to;
	$('join-amount').value = String(zec);
	onAmountInput();
	$('join').scrollIntoView({ behavior: 'smooth', block: 'center' });
	$('join-go').focus();
}

// ── your ticket (boarding pass) ─────────────────────────────────────
function renderSeat() {
	const card = $('seat-card');
	const joinCard = $('join-card');
	if (!state.mySeat?.seat) { card.hidden = true; joinCard.hidden = false; return; }
	card.hidden = false; joinCard.hidden = false; // keep "board another" visible too

	const { seat, bus, ownerToken } = state.mySeat;
	const ready = bus.status === 'ready';
	const summary = $('seat-summary');
	const line = (k, v) => el('div', { class: 'seat-line' }, el('span', { text: k }), v?.nodeType ? el('span', {}, v) : el('span', { text: String(v) }));
	summary.replaceChildren(
		line('Route', `${shortOf(bus.from)} → ${shortOf(bus.to)} (${nameOf(bus.to)})`),
		line('Blend-in amount', `${fmtAmount(bus.amount_zec)} ZEC`),
		line('Bus', el('span', { class: `seat-badge seat-badge--${ready ? 'ready' : 'boarding'}`, text: STATUS_LABEL[bus.status] || bus.status })),
		line('Seats', `${bus.seats_filled}/${bus.min_passengers}`),
		line('Your seat', seat.status),
	);
	if (bus.privacy?.headline) summary.append(el('p', { class: 'token__note', text: bus.privacy.headline }));

	const tokenBox = $('token-box');
	if (ownerToken) { tokenBox.hidden = false; $('token-value').value = ownerToken; }
	else tokenBox.hidden = true;

	const actions = $('seat-actions');
	actions.replaceChildren();
	if (ready) {
		actions.append(el('a', {
			class: 'btn btn--primary', href: 'https://winbit32.com', target: '_blank', rel: 'noopener',
			text: `Broadcast your ${shortOf(bus.from)}→${shortOf(bus.to)} swap ▶`,
		}));
	}
	if (seat.status === 'reserved') actions.append(el('button', { class: 'btn', text: 'Confirm boarded', onclick: () => doSeat('board') }));
	actions.append(el('button', { class: 'btn btn--ghost', text: 'Leave seat', onclick: () => doSeat('leave') }));
	if (ready) actions.append(el('p', { class: 'token__note', text: `Swap ${fmtAmount(bus.amount_zec)} ZEC → ${shortOf(bus.to)} during the window, to a fresh destination. One-click broadcast is coming inside WINBIT32.` }));
}

// ── caveats ─────────────────────────────────────────────────────────
function renderCaveats() {
	const ul = $('caveats-list');
	ul.replaceChildren();
	for (const c of state.caveats) ul.append(el('li', { text: c }));
}

// ── actions ─────────────────────────────────────────────────────────
function canReserve() {
	const zec = Number($('join-amount').value);
	if (!Number.isFinite(zec) || zec <= 0) return false;
	return state.blendZats.size === 0 ? true : state.blendZats.has(toZats(zec));
}
function setBusy(v) { state.busy = v; $('join-go').disabled = v || !canReserve(); }

function onAmountInput() {
	const zec = Number($('join-amount').value);
	const hint = $('amount-hint');
	if (Number.isFinite(zec) && zec > 0 && state.blendZats.size && !state.blendZats.has(toZats(zec))) {
		hint.className = 'hint hint--warn';
		hint.textContent = "Not a common blend-in amount — pick one below, or a bus of identical odd amounts is just a shared fingerprint.";
	} else { hint.className = 'hint'; hint.textContent = ''; }
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
		$('seat-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
		refresh();
	} else {
		const hint = $('amount-hint');
		hint.className = 'hint hint--warn';
		hint.textContent = res.error?.message || (res.reason === 'disabled' ? 'The bus board is not enabled right now.' : 'Could not reserve a seat — try again.');
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
	const lists = await listBuses();
	let found = null;
	if (lists.ok) {
		for (const b of lists.data.buses || []) {
			const one = await getBus(b.id, seatId, token);
			if (one.ok && one.data?.seat) { found = { seat: one.data.seat, bus: one.data.bus, ownerToken: null }; break; }
		}
	}
	if (found) { state.mySeat = found; renderSeat(); $('resume-box').hidden = true; }
	else {
		const hint = $('amount-hint');
		hint.className = 'hint hint--warn';
		hint.textContent = 'Could not find that seat on an open bus (it may have departed or expired).';
	}
}

// ── polling ─────────────────────────────────────────────────────────
async function refresh() {
	const to = $('filter-to').value;
	const res = await listBuses(to);
	if (res.reason === 'disabled') { state.disabled = true; renderBoard(); renderStats(); return; }
	state.disabled = false;
	if (res.ok && res.data) {
		state.buses = Array.isArray(res.data.buses) ? res.data.buses : [];
		state.stats = res.data.stats || null;
		if (Array.isArray(res.data.caveats) && res.data.caveats.length) { state.caveats = res.data.caveats; renderCaveats(); }
	}
	renderBoard();
	renderStats();
	renderTicker();

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
		state.blend = res.data.amounts.map((a) => ({ zec: a.zec, zats: a.zats ?? toZats(a.zec), count: a.count }));
		state.blendZats = new Set(state.blend.map((a) => a.zats));
		renderChips();
		onAmountInput();
		renderBoard();
		renderStats();
		renderTicker();
	}
}

// ── init ────────────────────────────────────────────────────────────
function fillAssetSelects() {
	const filter = $('filter-to');
	const join = $('join-to');
	for (const a of EXIT_ASSETS) {
		filter.append(el('option', { value: a.id, text: `${a.label} (${a.short})` }));
		join.append(el('option', { value: a.id, text: `${a.label} (${a.short})` }));
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
tickClock();
setInterval(tickClock, 1000);
renderBoard();   // render scheduled routes immediately so the board is never blank
renderStats();
renderTicker();
loadBlend();
refresh();
setInterval(refresh, POLL_MS);
