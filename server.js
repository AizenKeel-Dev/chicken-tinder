// Chicken Tinder: a tiny no-accounts server.
// Rounds live in memory and expire on their own. Restaurants come from OpenStreetMap
// (Nominatim to turn an address into a point, Overpass to list restaurants around it).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const NOMINATIM = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const OVERPASS = (process.env.OVERPASS_URLS || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter').split(',');
const USER_AGENT = process.env.CONTACT_UA || 'ChickenTinder/1.0 (personal dinner-picker app)';

const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

const ROUND_TTL = 6 * 60 * 60 * 1000;   // a round lasts six hours
const MAX_ROUNDS = 2000;
const MAX_PLAYERS = 8;
const MAX_BODY = 2048;
const MAX_RADIUS_MI = 15;
const DECK_SIZE = 40;
const OVERPASS_WAIT = 18000;             // ms to wait on the Overpass mirrors before falling back
const NOMINATIM_GAP = 1100;              // ms between Nominatim calls (their policy: one request per second)
const CREATES_PER_HOUR = 20;             // per IP; each create calls OpenStreetMap services
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O

const rounds = new Map();   // code -> {code, radius, deck:[item], ids:Set, players: Map(pid -> {name, likes:Set, passes:Set}), touched}
const creates = new Map();  // ip -> [timestamps]

function newCode() {
  let c;
  do { c = Array.from(crypto.randomBytes(4), b => ALPHA[b % ALPHA.length]).join(''); } while (rounds.has(c));
  return c;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function sweep() {
  const now = Date.now();
  for (const [c, r] of rounds) if (now - r.touched > ROUND_TTL) rounds.delete(c);
  for (const [ip, ts] of creates) { const keep = ts.filter(t => now - t < 3600e3); keep.length ? creates.set(ip, keep) : creates.delete(ip); }
}
setInterval(sweep, 10 * 60 * 1000).unref();

class Problem extends Error { constructor(status, message) { super(message); this.status = status; } }

async function getJson(url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 25000);
  const signal = opts && opts.signal ? AbortSignal.any([ctl.signal, opts.signal]) : ctl.signal;
  try {
    const r = await fetch(url, { ...opts, signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(opts && opts.headers) } });
    if (!r.ok) throw new Error('upstream ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// Every Nominatim call goes through here so the whole server stays under one request per second.
let nominatimAt = 0;
async function nominatim(query) {
  const wait = nominatimAt + NOMINATIM_GAP - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  nominatimAt = Date.now();
  return getJson(NOMINATIM + '?format=jsonv2&' + query);
}

// `where` is either a free-form string or {street, city, state, zip}. Structured parts go to Nominatim's
// structured search first (more exact than free text), then as one free-form line if that finds nothing.
async function geocode(where) {
  const queries = [];
  if (typeof where === 'string') queries.push('limit=1&q=' + encodeURIComponent(where));
  else {
    const p = new URLSearchParams({ limit: '1' });
    if (where.street) p.set('street', where.street);
    if (where.city) p.set('city', where.city);
    if (where.state) p.set('state', where.state);
    if (where.zip) p.set('postalcode', where.zip);
    if (/^\d{5}(-\d{4})?$/.test(where.zip)) p.set('countrycodes', 'us');   // a bare US ZIP otherwise matches postcodes abroad
    queries.push(p.toString());
    const line = [where.street, where.city, [where.state, where.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    queries.push('limit=1&q=' + encodeURIComponent(line) + (p.has('countrycodes') ? '&countrycodes=us' : ''));
  }
  let answered = false;
  for (const q of queries) {
    let hits;
    try { hits = await nominatim(q); } catch (e) { continue; }
    answered = true;
    const h = Array.isArray(hits) && hits[0];
    const lat = h && Number(h.lat), lon = h && Number(h.lon);
    if (h && Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  if (!answered) throw new Problem(502, "The address lookup isn't answering. Try again, or use your location instead.");
  throw new Problem(400, "Couldn't find that address. Check the city, state and ZIP, or use your location.");
}

function milesBetween(a, b) {
  const R = 3958.8, rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
function cuisineOf(tags) {
  const c = text(tags.cuisine, 60).split(/[;,]/)[0].replace(/_/g, ' ').trim();
  if (c) return c[0].toUpperCase() + c.slice(1);
  return tags.amenity === 'fast_food' ? 'Fast food' : 'Restaurant';
}

// Ask every Overpass mirror at once; the first good answer wins and the rest are cancelled.
// Returns null when none of them answered in time.
async function overpassElements(q) {
  const ctl = new AbortController();
  const body = 'data=' + encodeURIComponent(q);
  const tries = OVERPASS.map(async url => {
    const data = await getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: ctl.signal }, OVERPASS_WAIT);
    if (!data || !Array.isArray(data.elements)) throw new Error('bad overpass reply');
    return data.elements;
  });
  try { return await Promise.any(tries); }
  catch (e) { return null; }
  finally { ctl.abort(); }
}

// Fallback when Overpass is down: Nominatim's bounded amenity search. Thinner (50 per query) but it keeps the app usable.
// Nominatim picks an arbitrary 50 from a big box, so a tight box is searched first to make sure the nearest places are in.
// Results are reshaped to look like Overpass elements so one parser serves both.
async function nominatimElements(center, radiusMi, fastFood) {
  const rings = radiusMi > 4 ? [3, radiusMi] : [radiusMi];
  let answered = false;
  const elements = [];
  for (const amenity of fastFood ? ['restaurant', 'fast_food'] : ['restaurant']) for (const ring of rings) {
    const dLat = ring / 69, dLon = ring / (69 * Math.cos(center.lat * Math.PI / 180));
    const viewbox = [center.lon - dLon, center.lat + dLat, center.lon + dLon, center.lat - dLat].map(n => n.toFixed(5)).join(',');
    let hits;
    try { hits = await nominatim('limit=50&extratags=1&addressdetails=1&bounded=1&amenity=' + amenity + '&viewbox=' + viewbox); }
    catch (e) { continue; }
    if (!Array.isArray(hits)) continue;
    answered = true;
    for (const h of hits) {
      const a = h.address || {}, x = h.extratags || {};
      elements.push({ type: h.osm_type, id: h.osm_id, lat: h.lat, lon: h.lon, tags: {
        name: h.name, amenity, cuisine: x.cuisine,
        'addr:housenumber': a.house_number, 'addr:street': a.road, 'addr:city': a.city || a.town || a.village,
      } });
    }
  }
  return answered ? elements : null;
}

async function nearby(center, radiusMi, fastFood) {
  const meters = Math.round(radiusMi * 1609.344);
  const kinds = fastFood ? '^(restaurant|fast_food)$' : '^restaurant$';
  const q = `[out:json][timeout:15];nwr(around:${meters},${center.lat.toFixed(5)},${center.lon.toFixed(5)})["amenity"~"${kinds}"]["name"];out center tags 600;`;
  let elements = await overpassElements(q);
  if (!elements) elements = await nominatimElements(center, radiusMi, fastFood);
  if (!elements) throw new Problem(502, 'The restaurant lookup is busy right now. Try again in a moment.');
  // One card per restaurant name: chains like Waffle House show up once, at their closest location.
  const best = new Map();
  for (const el of elements) {
    const tags = el.tags || {};
    const lat = Number(el.lat ?? (el.center && el.center.lat)), lon = Number(el.lon ?? (el.center && el.center.lon));
    const name = text(tags.name, 80);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const miles = milesBetween(center, { lat, lon });
    if (miles > radiusMi + 0.05) continue;
    const key = name.toLowerCase().replace(/\s*#\s*\d+\s*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const prior = best.get(key);
    if (prior && prior.miles <= Math.round(miles * 10) / 10) continue;
    const street = [text(tags['addr:housenumber'], 12), text(tags['addr:street'], 60)].filter(Boolean).join(' ');
    best.set(key, {
      id: String(el.type || 'x')[0] + String(el.id),
      name, cuisine: cuisineOf(tags),
      miles: Math.round(miles * 10) / 10,
      addr: [street, text(tags['addr:city'], 40)].filter(Boolean).join(', '),
      lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5,
    });
  }
  return [...best.values()];
}

const validPid = p => typeof p === 'string' && /^[a-z0-9]{12,40}$/.test(p);
const cleanName = n => text(n, 20).replace(/[<>]/g, '');

function player(round, pid, name) {
  let p = round.players.get(pid);
  if (!p) {
    if (round.players.size >= MAX_PLAYERS) return null;
    p = { name: '', likes: new Set(), passes: new Set() };
    round.players.set(pid, p);
  }
  const n = cleanName(name);
  if (n) p.name = n;
  if (!p.name) p.name = 'Player ' + ([...round.players.keys()].indexOf(pid) + 1);
  return p;
}
// What one player may see: their own picks, everyone's progress, and only the mutual matches.
// The round's center point never leaves the server.
function view(round, pid) {
  const all = [...round.players.values()];
  const matches = all.length < 2 ? [] : round.deck.filter(r => all.every(p => p.likes.has(r.id))).map(r => r.id);
  const me = round.players.get(pid);
  return {
    code: round.code, radius: round.radius, deck: round.deck,
    you: me ? { likes: [...me.likes], passes: [...me.passes] } : { likes: [], passes: [] },
    players: [...round.players.entries()].map(([id, p]) => ({ name: p.name, seen: p.likes.size + p.passes.size, you: id === pid })),
    matches,
  };
}

function send(res, status, body, type) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  res.end(data);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Problem(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Problem(400, 'Bad request.')); } });
    req.on('error', reject);
  });
}

async function createRound(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const recent = (creates.get(ip) || []).filter(t => now - t < 3600e3);
  if (recent.length >= CREATES_PER_HOUR) throw new Problem(429, 'Too many rounds started from here. Try again in a bit.');
  if (rounds.size >= MAX_ROUNDS) { sweep(); if (rounds.size >= MAX_ROUNDS) throw new Problem(503, 'Too many rounds are running right now. Try again shortly.'); }
  const body = await readJson(req);
  if (!validPid(body.pid)) throw new Problem(400, 'Bad player id.');
  const radius = Number(body.radius);
  if (!(radius >= 1 && radius <= MAX_RADIUS_MI)) throw new Problem(400, 'Pick a radius between 1 and ' + MAX_RADIUS_MI + ' miles.');
  recent.push(now); creates.set(ip, recent);

  let center;
  const lat = Number(body.lat), lon = Number(body.lon);
  if (body.lat != null && body.lon != null && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) center = { lat, lon };
  else {
    const parts = { street: text(body.street, 120), city: text(body.city, 60), state: text(body.state, 30), zip: text(body.zip, 12) };
    const address = text(body.address, 200);
    const where = Object.values(parts).some(Boolean) ? parts : address;
    if ((typeof where === 'string' ? where : Object.values(where).join('')).length < 3) throw new Problem(400, 'Share your location or type an address first.');
    center = await geocode(where);
  }
  const found = await nearby(center, radius, body.fastFood === true);
  if (!found.length) throw new Problem(400, 'No restaurants turned up within ' + radius + ' miles. Try a wider radius.');
  const deck = shuffle(found).slice(0, DECK_SIZE);
  const round = { code: newCode(), radius, deck, ids: new Set(deck.map(r => r.id)), players: new Map(), touched: Date.now() };
  rounds.set(round.code, round);
  player(round, body.pid, body.name);
  send(res, 201, view(round, body.pid));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, file)), type);
    }
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'POST' && p === '/api/rounds') return await createRound(req, res);

    const m = p.match(/^\/api\/rounds\/([A-Za-z]{4})(\/join|\/swipe)?$/);
    if (m) {
      const round = rounds.get(m[1].toUpperCase());
      if (!round || Date.now() - round.touched > ROUND_TTL) throw new Problem(404, 'That round has ended.');
      if (req.method === 'GET' && !m[2]) {
        const pid = url.searchParams.get('pid');
        return send(res, 200, view(round, validPid(pid) ? pid : ''));
      }
      if (req.method === 'POST' && m[2]) {
        const body = await readJson(req);
        if (!validPid(body.pid)) throw new Problem(400, 'Bad player id.');
        const pl = player(round, body.pid, body.name);
        if (!pl) throw new Problem(403, 'This round is full.');
        if (m[2] === '/swipe') {
          if (typeof body.id !== 'string' || !round.ids.has(body.id)) throw new Problem(400, 'Unknown restaurant.');
          if (body.yes === true) { pl.passes.delete(body.id); pl.likes.add(body.id); }
          else { pl.likes.delete(body.id); pl.passes.add(body.id); }
        }
        round.touched = Date.now();
        return send(res, 200, view(round, body.pid));
      }
    }
    throw new Problem(404, 'Not found.');
  } catch (e) {
    if (e instanceof Problem) send(res, e.status, { error: e.message });
    else { console.error('request failed:', e && e.message); send(res, 500, { error: 'Something went wrong on our side. Try again.' }); }
  }
});
server.listen(PORT, () => console.log('Chicken Tinder listening on ' + PORT));
