(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: fine */ } },
  };
  function randomId() {
    const a = new Uint8Array(20); crypto.getRandomValues(a);
    return Array.from(a, b => (b % 36).toString(36)).join('');
  }
  let pid = store.get('ct-pid');
  if (!/^[a-z0-9]{12,40}$/.test(pid || '')) { pid = randomId(); store.set('ct-pid', pid); }

  const S = {
    code: '', round: null, radius: 5, loc: null,
    likes: new Set(), passes: new Set(), shown: new Set(),
    dragging: false, pending: false, timer: null,
  };
  const notice = $('#notice'), stage = $('#stage');
  function say(msg) { notice.textContent = msg || ''; notice.hidden = !msg; }

  async function api(method, path, body) {
    let r;
    try {
      r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { throw { status: 0, error: "Can't reach Chicken Tinder. Check your connection and try again." }; }
    let data = null;
    try { data = await r.json(); } catch (e) { /* empty */ }
    if (!r.ok) throw { status: r.status, error: (data && data.error) || 'Something went wrong. Try again.' };
    return data;
  }

  /* ---------- home ---------- */
  $('#name').value = store.get('ct-name') || '';
  const myName = () => { const n = $('#name').value.trim(); store.set('ct-name', n); return n; };

  $('#radii').addEventListener('click', e => {
    const b = e.target.closest('button[data-r]'); if (!b) return;
    S.radius = +b.dataset.r;
    document.querySelectorAll('#radii button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });

  const ADDR = ['street', 'city', 'state', 'zip'];
  const typedAddress = () => Object.fromEntries(ADDR.map(k => [k, $('#' + k).value.trim()]));
  const locBtn = $('#locate');
  const unsetLoc = () => { S.loc = null; locBtn.disabled = false; locBtn.textContent = 'Use my current location'; locBtn.classList.remove('set'); };

  // Watch for a fix instead of taking the first cached one: phones often hand back a coarse
  // cell-tower guess first and a GPS reading a few seconds later. Stop early on a good fix.
  locBtn.addEventListener('click', () => {
    if (!navigator.geolocation) { say("This browser can't share location. Type an address instead."); return; }
    locBtn.disabled = true; locBtn.textContent = 'Finding you…'; say('');
    let best = null, watch = null, timer = null, done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(timer); if (watch !== null) navigator.geolocation.clearWatch(watch);
      if (!best) { unsetLoc(); say("Couldn't get your location. Allow location for this site in Safari, or type an address instead."); return; }
      const acc = best.coords.accuracy || 0;
      S.loc = { lat: best.coords.latitude, lon: best.coords.longitude };
      locBtn.disabled = false; locBtn.classList.add('set');
      locBtn.textContent = 'Using your current location' + (acc > 500 ? ' (rough fix)' : '');
      ADDR.forEach(k => { $('#' + k).value = ''; });
      if (acc > 500) say('Your location fix is only good to about ' + (acc >= 1000 ? (Math.round(acc / 160.9) / 10) + ' mi' : Math.round(acc) + ' m') + '. If the results look off, type an address instead.');
    };
    watch = navigator.geolocation.watchPosition(pos => {
      if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
      if (pos.coords.accuracy <= 100) finish();
    }, () => finish(), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    timer = setTimeout(finish, 9000);
  });
  ADDR.forEach(k => $('#' + k).addEventListener('input', () => { if ($('#' + k).value.trim() && S.loc) unsetLoc(); }));

  $('#startform').addEventListener('submit', async e => {
    e.preventDefault();
    const addr = typedAddress();
    if (!S.loc && Object.values(addr).join('').length < 3) { say('Share your location or type an address first.'); return; }
    const btn = $('#start'); btn.disabled = true; btn.textContent = 'Finding restaurants…'; say('');
    try {
      const body = { pid, name: myName(), radius: S.radius, fastFood: $('#fast').checked };
      if (S.loc) { body.lat = S.loc.lat; body.lon = S.loc.lon; } else Object.assign(body, addr);
      enter(await api('POST', '/api/rounds', body));
    } catch (err) { say(err.error); }
    btn.disabled = false; btn.textContent = 'Find restaurants and start';
  });

  $('#joinform').addEventListener('submit', e => {
    e.preventDefault();
    const code = $('#code').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { say('Round codes are four letters, like ABCD.'); return; }
    join(code);
  });

  async function join(code) {
    say('');
    try { enter(await api('POST', '/api/rounds/' + code + '/join', { pid, name: myName() })); }
    catch (err) { leave(err.status === 404 ? 'That round has ended. Start a new one below.' : err.error); }
  }

  /* ---------- round ---------- */
  function enter(round) {
    S.code = round.code; S.likes = new Set(); S.passes = new Set(); S.shown = new Set();
    try { history.replaceState(null, '', '/?r=' + S.code); } catch (e) { /* ignore */ }
    $('#home').hidden = true; $('#round').hidden = false;
    $('#roundcode').textContent = S.code; $('#linktext').hidden = true;
    absorb(round);
    clearInterval(S.timer);
    S.timer = setInterval(poll, 1500);
  }
  function leave(msg) {
    clearInterval(S.timer); S.timer = null; S.code = ''; S.round = null;
    try { history.replaceState(null, '', '/'); } catch (e) { /* ignore */ }
    $('#match').hidden = true; $('#round').hidden = true; $('#home').hidden = false;
    say(msg || '');
  }
  function absorb(round) {
    if (round.code !== S.code) return;
    round.you.likes.forEach(id => { if (!S.passes.has(id)) S.likes.add(id); });
    round.you.passes.forEach(id => { if (!S.likes.has(id)) S.passes.add(id); });
    S.round = round; render();
  }
  async function poll() {
    if (!S.code || document.hidden) return;
    const code = S.code;
    try { const r = await api('GET', '/api/rounds/' + code + '?pid=' + pid); if (code === S.code) absorb(r); }
    catch (err) { if (err.status === 404 && code === S.code) leave('That round has ended. Start a new one below.'); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  const inviteLink = () => location.origin + '/?r=' + S.code;
  $('#share').addEventListener('click', async () => {
    const url = inviteLink(), lt = $('#linktext');
    if (navigator.share) {
      try { await navigator.share({ title: 'Chicken Tinder', text: 'Swipe with me. The first place we both like is dinner.', url }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    lt.textContent = url; lt.hidden = false;
    try { await navigator.clipboard.writeText(url); say('Invite link copied. Paste it in a text.'); }
    catch (e) { say('Copy the link below and text it to your partner.'); }
  });

  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const sub = x => [x.cuisine, x.miles + ' mi', x.addr].filter(Boolean).join(' · ');
  const mapUrl = x => 'https://maps.apple.com/?q=' + encodeURIComponent(x.name) + '&ll=' + x.lat + ',' + x.lon;

  function cardHTML(x, cls) {
    return '<article class="card ' + cls + '"' + (cls === 'top' ? ' id="top"' : ' aria-hidden="true"') + '>' +
      '<div class="band b' + (hash(x.cuisine || x.name) % 4 + 1) + '">' + esc(x.cuisine || 'Restaurant') + '</div>' +
      (cls === 'top' ? '<span class="stamp y">YES</span><span class="stamp n">PASS</span>' : '') +
      '<div class="body"><p class="name">' + esc(x.name) + '</p><p class="where">' + esc([x.miles + ' mi away', x.addr].filter(Boolean).join(' · ')) + '</p></div></article>';
  }

  function render() {
    if (S.dragging) { S.pending = true; return; }
    S.pending = false;
    const r = S.round; if (!r) return;
    const deck = r.deck, total = deck.length;
    const mySeen = S.likes.size + S.passes.size;
    $('#people').innerHTML = r.players.map(p =>
      '<span class="person">' + esc(p.you ? 'You' : p.name) + ' <b>' + (p.you ? Math.max(p.seen, mySeen) : p.seen) + '/' + total + '</b></span>').join('');
    const left = deck.filter(x => !S.likes.has(x.id) && !S.passes.has(x.id));
    const cur = left[0], nxt = left[1];
    const others = r.players.filter(p => !p.you);
    const newBtn = '<button type="button" class="text" data-act="new">Start a different round</button>';
    if (cur) {
      stage.innerHTML = '<div class="swipe">' +
        '<div class="meta"><span>' + (total - left.length + 1) + ' of ' + total + ' · within ' + r.radius + ' mi</span>' + newBtn + '</div>' +
        '<div class="stack">' + (nxt ? cardHTML(nxt, 'under') : '') + cardHTML(cur, 'top') + '</div>' +
        '<div class="actions"><button type="button" id="pass">Pass</button><button type="button" class="primary" id="yes">I\'d eat here</button></div>' +
        (others.length ? '' : '<p class="muted">Nobody else has joined yet. Tap Send invite link and text it to your partner. You can start swiping now.</p>') + '</div>';
      wireCard(cur);
    } else {
      const waiting = others.filter(p => p.seen < total);
      let h, t;
      if (r.matches.length) { h = "You've seen them all"; t = 'You matched on ' + r.matches.length + (r.matches.length === 1 ? ' place.' : ' places.') + ' Pick from the list below.'; }
      else if (!others.length) { h = "You're done. Now the other half."; t = 'Your picks are saved. Send the invite link, and matches will show up here as your partner swipes.'; }
      else if (waiting.length) { h = 'Waiting on ' + esc(waiting[0].name); t = "You've swiped everything. A match will pop up here the moment one lands."; }
      else { h = 'No match this round'; t = "You didn't both say yes to anything. Start a different round with a wider radius."; }
      stage.innerHTML = '<div class="panel"><h2>' + h + '</h2><p>' + t + '</p>' + newBtn + '</div>';
    }
    const byId = new Map(deck.map(x => [x.id, x]));
    const m = r.matches.map(id => byId.get(id)).filter(Boolean);
    const mEl = $('#matches'); mEl.hidden = !m.length;
    if (m.length) mEl.innerHTML = '<div class="panel"><h2>Matches</h2><ul class="list">' + m.map(x =>
      '<li><span class="t">' + esc(x.name) + '<small>' + esc(sub(x)) + '</small></span><a href="' + esc(mapUrl(x)) + '" target="_blank" rel="noopener">Map</a></li>').join('') + '</ul></div>';
    const fresh = m.find(x => !S.shown.has(x.id));
    if (fresh) { m.forEach(x => S.shown.add(x.id)); showMatch(fresh); }
  }

  function showMatch(x) {
    $('#m-name').textContent = x.name; $('#m-sub').textContent = sub(x); $('#m-map').href = mapUrl(x);
    $('#match').hidden = false; $('#m-close').focus();
  }
  $('#m-close').addEventListener('click', () => { $('#match').hidden = true; });

  stage.addEventListener('click', e => {
    const b = e.target.closest('button[data-act="new"]');
    if (b) leave('');
  });

  /* ---------- swiping ---------- */
  function wireCard(cur) {
    const el = $('#top'); let x0 = null, dx = 0;
    const ys = el.querySelector('.y'), ns = el.querySelector('.n');
    el.addEventListener('pointerdown', e => { x0 = e.clientX; dx = 0; S.dragging = true; el.style.transition = 'none'; try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } });
    el.addEventListener('pointermove', e => {
      if (x0 === null) return; dx = e.clientX - x0;
      el.style.transform = 'translateX(' + dx + 'px) rotate(' + dx / 18 + 'deg)';
      ys.style.opacity = Math.max(0, Math.min(1, dx / 90)); ns.style.opacity = Math.max(0, Math.min(1, -dx / 90));
    });
    const up = () => {
      if (x0 === null) return; x0 = null; S.dragging = false;
      if (Math.abs(dx) > 90) fly(cur, dx > 0);
      else { el.style.transition = 'transform .2s'; el.style.transform = ''; ys.style.opacity = ns.style.opacity = 0; if (S.pending) render(); }
    };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    $('#pass').addEventListener('click', () => fly(cur, false));
    $('#yes').addEventListener('click', () => fly(cur, true));
  }
  function fly(cur, yes) {
    if (S.likes.has(cur.id) || S.passes.has(cur.id)) return;
    const el = $('#top'), still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const commit = () => { (yes ? S.likes : S.passes).add(cur.id); render(); sendSwipe(cur.id, yes); };
    if (!el || still) { commit(); return; }
    S.dragging = true; el.style.transition = 'transform .22s ease-in';
    el.style.transform = 'translateX(' + (yes ? 520 : -520) + 'px) rotate(' + (yes ? 24 : -24) + 'deg)';
    setTimeout(() => { S.dragging = false; commit(); }, 200);
  }
  async function sendSwipe(id, yes, attempt) {
    const code = S.code; if (!code) return;
    try { const r = await api('POST', '/api/rounds/' + code + '/swipe', { pid, id, yes }); say(''); if (code === S.code) absorb(r); }
    catch (err) {
      if (err.status === 404) { if (code === S.code) leave('That round has ended. Start a new one below.'); }
      else if ((attempt || 0) < 3 && (err.status === 0 || err.status >= 500)) setTimeout(() => sendSwipe(id, yes, (attempt || 0) + 1), 1500);
      else say("A swipe didn't save. " + err.error);
    }
  }
  document.addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName) || !$('#match').hidden) return;
    if (e.key === 'ArrowRight' && $('#yes')) $('#yes').click();
    if (e.key === 'ArrowLeft' && $('#pass')) $('#pass').click();
  });

  /* ---------- boot ---------- */
  const fromLink = (new URLSearchParams(location.search).get('r') || '').toUpperCase();
  if (/^[A-Z]{4}$/.test(fromLink)) join(fromLink); else $('#home').hidden = false;
})();
