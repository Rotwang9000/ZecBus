// ZecBus Station — talks directly to the winbit32 gateway's free, non-custodial
// bus-coordination REST surface. No build step, no framework, nothing persisted:
// the one-time seat token lives in memory (shown with a Copy button so you can
// save it yourself and resume later).

const API_BASE = 'https://mcp.winbit32.com';
const BUS_BASE = `${API_BASE}/v1/zec/bus`;
const popularUrl = (side) => `${API_BASE}/v1/zec/popular-amounts?side=${side === 'shield' ? 'shield' : 'deshield'}&limit=24`;
const MCP_URL = `${API_BASE}/mcp`;
const POLL_MS = 12000;
const ZATS = 1e8;
const MAX_BOARD_ROWS = 10;

// OPTIONAL in-browser hand-off. WINBIT32 (the wallet-kit host, with the built-in
// Exchange) opens prefilled from a hash deep-link; the rider connects their own
// wallet there and broadcasts. Swaps through it carry WINBIT32's standard
// affiliate fee — so this is the "do it from your browser, small fee" path,
// while broadcasting from your own wallet stays the recommended default.
const WINBIT32_BASE = 'https://winbit32.com';
const winbit32SwapUrl = ({ to, amountZec }) => {
	const ini = ['token_from=ZEC.ZEC', `token_to=${to}`];
	if (Number.isFinite(amountZec) && amountZec > 0) ini.push(`amount=${amountZec}`);
	return `${WINBIT32_BASE}/#winbit32.exe/exchange.exe/${ini.join('&')}`;
};
// Shield/unshield are z↔t wallet sends (not swaps), so just open the wallet.
const winbit32WalletUrl = () => `${WINBIT32_BASE}/#winbit32.exe`;

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

// Pool-boundary "services" a bus coordinates. swap = ZEC→another chain;
// unshield = z→t (deshield, leave the pool to transparent ZEC); shield = t→z
// (enter the pool). Shield/unshield are the direct fix for the shield-then-
// deshield-the-same-amount self-dox the Wall of Shame catalogues.
const KIND_META = {
	swap: { label: 'Swap out', verb: 'swap' },
	unshield: { label: 'Unshield', verb: 'unshield', destMain: 'Transparent', destSub: 'ZEC · z→t', note: 'Leave the shielded pool to a transparent ZEC address — alongside others doing the exact same amount, so your t-side exit doesn\u2019t 1:1-match your earlier shield.' },
	shield: { label: 'Shield', verb: 'shield', destMain: 'Shielded', destSub: 'ZEC · t→z', note: 'Enter the shielded pool from a transparent address — with others shielding the same round amount, so the entry doesn\u2019t fingerprint you.' },
};
const busKind = (b) => (b && KIND_META[b.kind] ? b.kind : 'swap');

const STATUS_LABEL = { boarding: 'Boarding', ready: 'Ready', departed: 'Departed', expired: 'Expired', cancelled: 'Cancelled' };

// Destination cell content for any kind (swap shows the chain; shield/unshield
// show the pool side they cross to).
function destInfo(kind, to) {
	const m = KIND_META[kind] || KIND_META.swap;
	if (kind === 'unshield' || kind === 'shield') return { main: m.destMain, sub: m.destSub };
	return { main: shortOf(to), sub: 'from ZEC' };
}

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

const listBuses = ({ kind, to } = {}) => {
	const p = [];
	if (kind === 'unshield' || kind === 'shield') p.push(`kind=${kind}`);
	else if (to) p.push(`to=${encodeURIComponent(to)}`);
	return api(`${BUS_BASE}${p.length ? `?${p.join('&')}` : ''}`);
};
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
	mode: '',        // board filter: '' (all) | 'swap' | 'unshield' | 'shield'
	joinMode: 'swap',// ticket-office service: 'swap' | 'unshield' | 'shield'
	blendSide: 'deshield',
	lastBusId: null, // specific bus the modal is contextualised to (for sharing)
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
	const routes = new Set(live.map((b) => b.route || `${b.from}>${b.to}`)).size;
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
			const k = busKind(b);
			const dest = k === 'swap' ? `→ ${shortOf(b.to)}` : (k === 'unshield' ? 'unshield z→t' : 'shield t→z');
			parts.push(`${b.status === 'ready' ? '▶' : '●'} ${fmtAmount(b.amount_zec)} ZEC ${dest} · ${b.seats_filled}/${b.min_passengers} · ${tag}`);
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
	const kind = busKind(bus);
	const d = destInfo(kind, bus.to);
	const tr = el('tr', { class: `is-${ready ? 'ready' : 'live'} kind-${kind}` });

	tr.append(
		el('td', { class: 'c-dest' },
			el('span', { class: 'dest flap' }, d.main, el('small', { text: d.sub }))),
		el('td', { class: 'c-amt' },
			el('span', { class: 'amt flap', html: `${fmtAmount(bus.amount_zec)} <small>ZEC</small>` })),
		el('td', { class: 'c-seats' },
			el('span', { class: 'seats', html: `<b>${bus.seats_filled}</b>/${bus.min_passengers}${bus.seats_departed ? ` <small>· ${bus.seats_departed} away</small>` : ''}` })),
		el('td', { class: 'c-status' },
			statusCell(bus.status, ready ? 'window open' : `${Math.max(0, (bus.min_passengers || 0) - (bus.seats_filled || 0))} to go`)),
	);

	const act = el('td', { class: 'c-act' });
	if (mine) act.append(el('button', { class: 'btn btn--board btn--sm', text: 'Your seat', onclick: openTicket }));
	else if (bus.status === 'boarding' || (ready && bus.seats_filled < bus.seats_max)) {
		act.append(el('button', {
			class: 'btn btn--board btn--sm', text: 'Board',
			onclick: () => openBoardModal({ kind, to: bus.to, amount: bus.amount_zec, min: bus.min_passengers, busId: bus.id }),
		}));
	}
	tr.append(act);
	return tr;
}

function scheduledRow({ kind, to, zec }) {
	const d = destInfo(kind, to);
	const tr = el('tr', { class: `is-sched kind-${kind}` });
	tr.append(
		el('td', { class: 'c-dest' },
			el('span', { class: 'dest' }, d.main, el('small', { text: d.sub }))),
		el('td', { class: 'c-amt' },
			el('span', { class: 'amt', html: `${fmtAmount(zec)} <small>ZEC</small>` })),
		el('td', { class: 'c-seats' },
			el('span', { class: 'seats', html: `<b>0</b>/5 <small>· open</small>` })),
		el('td', { class: 'c-status' }, statusCell('scheduled', 'be the first')),
		el('td', { class: 'c-act' },
			el('button', {
				class: 'btn btn--sched btn--sm', text: 'Start',
				onclick: () => openBoardModal({ kind, to, amount: zec, min: 5 }),
			})),
	);
	return tr;
}

// Which (kind, dest) combinations to surface as scheduled routes, honouring the
// board's current service filter. With no filter we mix swap-outs with an
// unshield option so both the "leave to a chain" and the "deshield with a
// crowd" cases are always visible.
function scheduledRoutes(slots) {
	if (slots <= 0) return [];
	const mode = state.mode;
	const filterTo = $('filter-to').value;
	const amounts = state.blendZats.size
		? HEADLINE_AMOUNTS.filter((z) => state.blendZats.has(toZats(z)))
		: HEADLINE_AMOUNTS;

	// (kind, dest) slots to fill, by mode.
	let combos;
	if (mode === 'unshield' || mode === 'shield') combos = [{ kind: mode, to: null }];
	else if (mode === 'swap') combos = (filterTo ? [filterTo] : SUGGEST_DESTS).map((to) => ({ kind: 'swap', to }));
	else combos = [{ kind: 'unshield', to: null }, ...SUGGEST_DESTS.map((to) => ({ kind: 'swap', to }))];

	const destKey = (kind, to) => (kind === 'swap' ? (to || '') : ''); // pool moves ignore `to`
	const liveKeys = new Set(state.buses.map((b) => `${busKind(b)}:${destKey(busKind(b), b.to)}@${toZats(b.amount_zec)}`));
	const out = [];
	for (const z of amounts) {
		for (const c of combos) {
			if (out.length >= slots) return out;
			if (liveKeys.has(`${c.kind}:${destKey(c.kind, c.to)}@${toZats(z)}`)) continue;
			out.push({ kind: c.kind, to: c.to, zec: z });
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
	for (const r of sched) body.append(scheduledRow(r));

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

// ── board-a-bus modal + shareable deep-links ────────────────────────
// Open the modal prefilled for a cohort. A specific `busId` (when given) is
// shown as live context and woven into the share URL, but reserving still joins
// by cohort (kind+amount+route+min) so a shared link lands you on the SAME bus
// even if that exact instance filled and rolled over.
function openBoardModal({ kind = 'swap', to, amount, min, busId } = {}) {
	state.lastBusId = busId || null;
	setJoinMode(kind);
	if (kind === 'swap' && to) $('join-to').value = to;
	if (amount != null && amount !== '') { $('join-amount').value = String(amount); }
	if (min != null && min !== '') $('join-min').value = String(min);
	onAmountInput();
	renderModalBus(busId);
	const dlg = $('board-modal');
	if (!dlg.open) dlg.showModal();
	syncBoardUrl({ kind, to: $('join-to').value, amount: $('join-amount').value, min: $('join-min').value, busId });
	setTimeout(() => { (canReserve() ? $('join-go') : $('join-amount')).focus(); }, 60);
}

function closeBoardModal() {
	const dlg = $('board-modal');
	if (dlg.open) dlg.close(); // fires 'close' → clears the URL
}

// Live context banner for the specific bus a rider tapped (if still on the board).
function renderModalBus(busId) {
	const banner = $('modal-bus');
	const bus = busId ? state.buses.find((b) => b.id === busId) : null;
	if (!bus) { banner.hidden = true; banner.className = 'modal-bus'; banner.replaceChildren(); return; }
	const kind = busKind(bus);
	const d = destInfo(kind, bus.to);
	banner.hidden = false;
	banner.className = `modal-bus kind-${kind}`;
	banner.replaceChildren(
		el('span', { class: 'modal-bus__route', text: `${d.main}${d.sub ? ` · ${d.sub}` : ''}` }),
		el('span', { class: 'modal-bus__amt', text: `${fmtAmount(bus.amount_zec)} ZEC` }),
		el('span', { class: 'modal-bus__seats', text: `${bus.seats_filled}/${bus.min_passengers} seats` }),
		statusCell(bus.status, bus.status === 'ready' ? 'window open' : `${Math.max(0, (bus.min_passengers || 0) - (bus.seats_filled || 0))} to go`),
	);
}

// Build the shareable URL for a cohort (query string, independent of the #anchors).
function boardShareUrl({ kind = 'swap', to, amount, min, busId } = {}) {
	const u = new URL(location.href);
	u.hash = '';
	u.search = '';
	const q = u.searchParams;
	q.set('board', '1');
	q.set('kind', kind);
	if (kind === 'swap' && to) q.set('to', to);
	if (amount) q.set('amount', String(amount));
	if (min) q.set('min', String(min));
	if (busId) q.set('bus', busId);
	return u.toString();
}
function syncBoardUrl(params) { history.replaceState(null, '', boardShareUrl(params)); }
function clearBoardUrl() { history.replaceState(null, '', location.pathname); }

// Robust copy: try the async Clipboard API (best on real browsers / https) AND
// fall back to a synchronous execCommand, so it also works in webviews and over
// plain-http LAN serving where the Clipboard API is gated or absent.
function copyText(text) {
	try { navigator.clipboard?.writeText(text)?.catch(() => {}); } catch { /* ignore */ }
	try {
		const ta = el('textarea', { readonly: '', 'aria-hidden': 'true' });
		ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
		ta.value = text;
		($('board-modal') || document.body).appendChild(ta); // dialog isn't inert
		ta.select();
		const ok = document.execCommand('copy');
		ta.remove();
		return ok;
	} catch { return false; }
}

function copyShareLink() {
	const url = boardShareUrl({
		kind: state.joinMode,
		to: $('join-to').value,
		amount: $('join-amount').value,
		min: $('join-min').value,
		busId: state.mySeat?.bus?.id || state.lastBusId || null,
	});
	const s = $('share-status');
	s.textContent = copyText(url) ? 'Link copied' : 'Select & copy the address bar to share';
	setTimeout(() => { s.textContent = ''; }, 2600);
}

// ── your ticket (boarding pass) ─────────────────────────────────────
function renderSeat() {
	const card = $('seat-card');
	const joinCard = $('join-card');
	const ticketBtn = $('open-ticket');
	if (ticketBtn) ticketBtn.hidden = !state.mySeat?.seat;
	if (!state.mySeat?.seat) { card.hidden = true; joinCard.hidden = false; return; }
	card.hidden = false; joinCard.hidden = false; // keep "board another" visible too

	const { seat, bus, ownerToken } = state.mySeat;
	const ready = bus.status === 'ready';
	const kind = busKind(bus);
	const routeText = kind === 'swap'
		? `${shortOf(bus.from)} → ${shortOf(bus.to)} (${nameOf(bus.to)})`
		: (bus.route_label || (kind === 'unshield' ? 'Unshield · shielded → transparent ZEC' : 'Shield · transparent → shielded ZEC'));
	const verb = (KIND_META[kind] || KIND_META.swap).verb;
	const summary = $('seat-summary');
	const line = (k, v) => el('div', { class: 'seat-line' }, el('span', { text: k }), v?.nodeType ? el('span', {}, v) : el('span', { text: String(v) }));
	summary.replaceChildren(
		line('Service', routeText),
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

	// DEFAULT / recommended: broadcast the move yourself, from your own wallet.
	if (ready) {
		const moveText = kind === 'swap'
			? `Swap ${fmtAmount(bus.amount_zec)} ZEC → ${shortOf(bus.to)} during the window, to a fresh destination.`
			: `${kind === 'unshield' ? 'Unshield' : 'Shield'} ${fmtAmount(bus.amount_zec)} ZEC during the window${kind === 'unshield' ? ', to a fresh transparent address' : ' from a fresh transparent input'}.`;
		actions.append(el('p', { class: 'seat-move', html: `<strong>Window open.</strong> ${moveText} The recommended way is to broadcast from <strong>your own wallet</strong>.` }));
	}
	if (seat.status === 'reserved') actions.append(el('button', { class: 'btn', text: 'Confirm boarded', onclick: () => doSeat('board') }));
	actions.append(el('button', { class: 'btn btn--ghost', text: 'Leave seat', onclick: () => doSeat('leave') }));

	// OPTIONAL: do it in-browser via WINBIT32 (the wallet-kit host). Clearly
	// secondary to using your own wallet; a small affiliate fee applies to swaps.
	if (ready) actions.append(walletHandoff(kind, bus));
}

// Optional in-browser hand-off panel. WINBIT32 opens prefilled in the rider's
// browser; they connect their own wallet there and broadcast. Never custodial.
function walletHandoff(kind, bus) {
	const box = el('div', { class: 'wallet-opt' });
	box.append(el('p', { class: 'wallet-opt__title', text: 'Optional — do it in your browser' }));
	if (kind === 'swap') {
		box.append(el('a', {
			class: 'btn btn--sm', href: winbit32SwapUrl({ to: bus.to, amountZec: bus.amount_zec }),
			target: '_blank', rel: 'noopener', text: `Swap ${shortOf(bus.from)} → ${shortOf(bus.to)} in WINBIT32 ▶`,
		}));
		box.append(el('p', { class: 'wallet-opt__note', text: 'Opens WINBIT32 prefilled — connect your own wallet there and broadcast. A small affiliate fee applies. ZecBus never touches your funds or keys; using your own wallet (above) stays the default.' }));
	} else {
		box.append(el('a', {
			class: 'btn btn--sm', href: winbit32WalletUrl(),
			target: '_blank', rel: 'noopener', text: 'Open WINBIT32 wallet ▶',
		}));
		box.append(el('p', { class: 'wallet-opt__note', text: `${kind === 'unshield' ? 'Unshield' : 'Shield'} from your wallet inside WINBIT32, in your browser. Optional — any wallet that can do a z↔t send works, and your own wallet stays the default.` }));
	}
	return box;
}

function openTicket() {
	const dlg = $('board-modal');
	if (!dlg.open) dlg.showModal();
	renderSeat();
	syncBoardUrl({
		kind: busKind(state.mySeat?.bus || {}),
		to: state.mySeat?.bus?.to,
		amount: state.mySeat?.bus?.amount_zec,
		min: state.mySeat?.bus?.min_passengers,
		busId: state.mySeat?.bus?.id || state.lastBusId,
	});
	$('seat-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

async function reserve({ kind = 'swap', to, amount, minPassengers, handle }) {
	if (state.busy) return;
	setBusy(true);
	const body = { kind, amount, minPassengers, handle: handle || undefined };
	if (kind === 'swap') body.to = to;
	const res = await joinBus(body);
	if (res.ok && res.data) {
		state.mySeat = { seat: res.data.seat, bus: res.data.bus, ownerToken: res.data.owner_token };
		state.lastBusId = res.data.bus?.id || state.lastBusId;
		if (Array.isArray(res.data.caveats)) { state.caveats = res.data.caveats; renderCaveats(); }
		renderSeat();
		if (!$('board-modal').open) $('board-modal').showModal();
		syncBoardUrl({ kind, to: body.to, amount, min: minPassengers, busId: state.lastBusId });
		$('seat-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
	const lists = await listBuses({});
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
	const res = await listBuses({ kind: state.mode, to });
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
	if ($('board-modal').open && state.lastBusId) renderModalBus(state.lastBusId);

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
	const res = await api(popularUrl(state.blendSide));
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

// ── mode (service) selectors ────────────────────────────────────────
function highlightTabs(containerId, mode) {
	for (const btn of $(containerId).querySelectorAll('.mode')) {
		btn.classList.toggle('is-on', (btn.dataset.mode || '') === mode);
	}
}

function setBoardMode(mode) {
	state.mode = mode;
	highlightTabs('board-modes', mode);
	// The destination filter only applies to swaps.
	const filter = $('filter-to');
	const swappy = mode === '' || mode === 'swap';
	filter.disabled = !swappy;
	filter.parentElement.classList.toggle('is-off', !swappy);
	if (!swappy) filter.value = '';
	renderBoard();
	refresh();
}

function setJoinMode(mode) {
	const m = KIND_META[mode] ? mode : 'swap';
	state.joinMode = m;
	highlightTabs('join-modes', m);
	$('join-to-field').hidden = m !== 'swap';
	$('join-mode-note').textContent = m === 'swap' ? '' : (KIND_META[m].note || '');
	// Shield wants the t→z popularity feed; everything else uses the z→t feed.
	const side = m === 'shield' ? 'shield' : 'deshield';
	if (side !== state.blendSide) { state.blendSide = side; loadBlend(); }
}

function wireEvents() {
	$('refresh').addEventListener('click', refresh);
	$('filter-to').addEventListener('change', refresh);
	$('join-amount').addEventListener('input', onAmountInput);
	for (const btn of $('board-modes').querySelectorAll('.mode')) {
		btn.addEventListener('click', () => setBoardMode(btn.dataset.mode || ''));
	}
	for (const btn of $('join-modes').querySelectorAll('.mode')) {
		btn.addEventListener('click', () => setJoinMode(btn.dataset.mode || 'swap'));
	}
	$('join-go').addEventListener('click', () => reserve({
		kind: state.joinMode,
		to: $('join-to').value,
		amount: Number($('join-amount').value),
		minPassengers: Number($('join-min').value) || 5,
		handle: $('join-handle').value.trim(),
	}));
	$('token-copy').addEventListener('click', () => copyText($('token-value').value));
	$('resume-toggle').addEventListener('click', () => { $('resume-box').hidden = !$('resume-box').hidden; });
	$('resume-go').addEventListener('click', resumeSeat);

	// board-a-bus modal
	$('open-board').addEventListener('click', () => openBoardModal({ kind: state.joinMode }));
	$('open-ticket').addEventListener('click', openTicket);
	$('modal-close').addEventListener('click', closeBoardModal);
	$('share-link').addEventListener('click', copyShareLink);
	const dlg = $('board-modal');
	dlg.addEventListener('close', clearBoardUrl);            // Esc, close(), or ✕
	dlg.addEventListener('click', (e) => { if (e.target === dlg) closeBoardModal(); }); // backdrop click
}

// Deep-link entry: ?board=1&kind=&to=&amount=&min=&bus= opens the right modal.
async function maybeOpenFromUrl() {
	const q = new URLSearchParams(location.search);
	if (q.get('board') !== '1' && !q.get('bus')) return;
	const kind = KIND_META[q.get('kind')] ? q.get('kind') : 'swap';
	const to = q.get('to') || undefined;
	const amtRaw = q.get('amount') ? Number(q.get('amount')) : undefined;
	const amount = Number.isFinite(amtRaw) ? amtRaw : undefined;
	const minRaw = q.get('min') ? Number(q.get('min')) : undefined;
	const min = Number.isFinite(minRaw) ? minRaw : undefined;
	const busId = q.get('bus') || undefined;
	// Bus-only link (no cohort params): fetch the bus to recover its cohort.
	if (busId && amount == null) {
		const r = await api(`${BUS_BASE}/${encodeURIComponent(busId)}`);
		if (r.ok && r.data?.bus) {
			const b = r.data.bus;
			openBoardModal({ kind: busKind(b), to: b.to, amount: b.amount_zec, min: b.min_passengers, busId });
			return;
		}
	}
	openBoardModal({ kind, to, amount, min, busId });
}

fillAssetSelects();
renderMcpConfig();
wireEvents();
setJoinMode('swap');
tickClock();
setInterval(tickClock, 1000);
renderBoard();   // render scheduled routes immediately so the board is never blank
renderStats();
renderTicker();
loadBlend();
refresh().then(maybeOpenFromUrl);
setInterval(refresh, POLL_MS);
