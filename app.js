/* ═══════════════════════════════════════════════════════════
   Fieldcast — visitor app
   Static HTML/CSS/JS, no build step. Content (experiences + stops)
   comes from Supabase so it can be edited/extended without a
   redeploy. Real geolocation drives three-tier audio zones
   (bleed / drop-off / high-point) per stop, matching the admin
   tool's per-marker radius settings.
   ═══════════════════════════════════════════════════════════ */

const SUPABASE_URL = 'https://gplxpnijrfnskakujtiu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdwbHhwbmlqcmZuc2tha3VqdGl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyMTkwNDcsImV4cCI6MjA4ODc5NTA0N30.nb24yCoTjhVBiifnkmZUOIYjkn3Xk4dqKyHPXtEBO5o';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const CITY_NAME = 'Maastricht';

const HOW_IT_WORKS = [
  'Enable your location',
  'Wear headphones',
  'Walk freely or use the map below',
  'Audio starts automatically when you enter a listening zone',
];

/* volume ramps 0 -> DROPOFF_VOL between bleed and dropoff radii,
   then DROPOFF_VOL -> 1 between dropoff and high-point radii */
const DROPOFF_VOL = 0.6;
/* close the sheet only once you're this much further out than the
   bleed radius, so GPS jitter right at the edge doesn't flap it */
const EXIT_HYSTERESIS = 1.15;

const $ = (id) => document.getElementById(id);
$('cityNameHero').textContent = CITY_NAME;
document.querySelectorAll('.cityName').forEach((el) => { el.textContent = CITY_NAME; });

const S = {
  experiences: [],
  markersById: {},
  view: 'home',
  currentExp: null,
  currentStops: [],
  lat: null, lon: null,
  gpsOn: false, gpsDenied: false, watchId: null,
  map: null, userMarker: null,
  stopLayers: {}, // id -> { marker, bleed, dropoff, highpoint }
  activeStopId: null,
  dismissedStopId: null,
  expanded: false,
  audio: null,
  unlocked: false,
};

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}
function prettyDist(m) {
  return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km';
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function esc(t) {
  return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastT;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('on'), 3200);
}

/* ═══════════════ routing ═══════════════ */
function go(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('on'));
  $('v-' + view).classList.add('on');
  S.view = view;
  if (view !== 'map') stopAudio();
  if (view === 'map') setTimeout(() => S.map && S.map.invalidateSize(), 100);
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-go]');
  if (btn) go(btn.dataset.go);
});

$('navExperiences').onclick = () => {
  go('home');
  $('cardsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/* ═══════════════ data ═══════════════ */
async function boot() {
  try {
    const [ex, mk] = await Promise.all([
      sb.from('experiences').select('*').in('status', ['published', 'coming_soon']).order('sort_order', { ascending: true }),
      sb.from('markers').select('*'),
    ]);
    if (ex.error) throw ex.error;
    if (mk.error) throw mk.error;
    S.experiences = ex.data || [];
    S.markersById = Object.fromEntries((mk.data || []).map((m) => [m.id, m]));
    renderCards();
    renderAbout();
  } catch (err) {
    console.error(err);
    $('cards').innerHTML = '<div class="empty-state">Couldn’t load walks — check your connection and reload.</div>';
    toast('Could not load experiences');
  }
}

function stopsOf(exp) {
  return (exp.marker_ids || []).map((id) => S.markersById[id]).filter(Boolean);
}

function renderCards() {
  const el = $('cards');
  if (!S.experiences.length) {
    el.innerHTML = '<div class="empty-state">No walks published yet.</div>';
    return;
  }
  el.innerHTML = S.experiences.map((e) => {
    const ready = e.status === 'published';
    const img = e.hero_image_url
      ? `background-image:url('${esc(e.hero_image_url)}')`
      : `background-image:repeating-linear-gradient(135deg,#FFFFFF,#FFFFFF 12px,rgba(199,49,194,0.06) 12px,rgba(199,49,194,0.06) 24px)`;
    return `<div class="card ${ready ? '' : 'not-ready'}" data-exp="${esc(e.id)}">
      <div class="card-img" style="${img}">
        ${!e.hero_image_url ? `<span class="card-img-label">${esc(e.location_label || '')}</span>` : ''}
        ${!ready ? `<div class="card-badge">Coming soon</div>` : ''}
      </div>
      <div class="card-body">
        <div class="card-title">${esc(e.title)}</div>
        <div class="card-tagline">${esc(e.tagline || '')}</div>
        <div class="card-cta">
          <span class="start-walk">Start Walk</span><span class="arw">→</span>
        </div>
      </div>
    </div>`;
  }).join('');
  el.querySelectorAll('.card:not(.not-ready)').forEach((c) => {
    c.onclick = () => openExperience(c.dataset.exp);
  });
}

function renderAbout() {
  const list = $('aboutExpList');
  if (!S.experiences.length) {
    list.innerHTML = '<div class="about-list-row">Coming soon</div>';
    return;
  }
  list.innerHTML = S.experiences.map((e) =>
    `<div class="about-list-row">${esc(e.title)}${e.location_label ? ` (${esc(e.location_label)})` : ''}</div>`
  ).join('');
}

/* ═══════════════ experience landing ═══════════════ */
function openExperience(id) {
  const exp = S.experiences.find((e) => e.id === id);
  if (!exp) return;
  S.currentExp = exp;
  S.currentStops = stopsOf(exp);

  $('expHero').style.backgroundImage = exp.hero_image_url
    ? `url('${exp.hero_image_url}')`
    : `repeating-linear-gradient(135deg,#DDF8F8,#DDF8F8 14px,#FFFFFF 14px,#FFFFFF 28px)`;
  $('expTitle').textContent = exp.title || '';
  $('expIntro').textContent = exp.description || exp.tagline || '';
  $('howItWorks').innerHTML = HOW_IT_WORKS.map((label, i) =>
    `<div class="step"><div class="step-num">${i + 1}</div><div class="step-label">${esc(label)}</div></div>`
  ).join('');

  const btn = $('btnOpenMap');
  btn.disabled = S.currentStops.length === 0;
  btn.textContent = S.currentStops.length === 0 ? 'No stops yet' : 'Open Map';

  go('exp');
}

$('btnOpenMap').onclick = () => {
  if (!S.currentStops.length) return;
  unlockAudio();
  go('map');
  $('mapExpTitle').textContent = S.currentExp.title || '';
  initMap();
  if (!S.gpsOn) startGps();
};
$('mapBack').onclick = () => go('exp');

/* ═══════════════ home GPS CTA ═══════════════ */
$('btnGps').onclick = () => {
  unlockAudio();
  $('gpsCtaLabel').textContent = 'Locating…';
  startGps();
  $('cardsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/* ═══════════════ geolocation ═══════════════ */
function startGps() {
  if (!('geolocation' in navigator)) {
    toast('This device has no location support');
    $('gpsCtaLabel').textContent = 'Enable GPS';
    return;
  }
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = navigator.geolocation.watchPosition(onPos, onPosErr, {
    enableHighAccuracy: true, maximumAge: 2000, timeout: 20000,
  });
}

function onPos(p) {
  S.lat = p.coords.latitude; S.lon = p.coords.longitude;
  S.gpsDenied = false;
  if (!S.gpsOn) { S.gpsOn = true; toast('Location on — walk toward a marker'); }
  $('gpsCtaLabel').textContent = 'Enable GPS';
  drawUser();
  checkZones();
}
function onPosErr(err) {
  S.gpsOn = false;
  $('gpsCtaLabel').textContent = 'Enable GPS';
  if (err.code === 1) {
    S.gpsDenied = true;
    toast('Location permission denied — enable it in your browser settings');
  } else {
    toast('Waiting for a GPS signal…');
  }
  updateIdleSheet();
}

/* ═══════════════ map ═══════════════ */
function initMap() {
  if (!S.map) {
    S.map = L.map('map', { zoomControl: false, attributionControl: true, tap: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 20, subdomains: 'abcd', attribution: '&copy; OpenStreetMap &copy; CARTO',
    }).addTo(S.map);
  }
  drawStops();
  const pts = S.currentStops.map((m) => [m.lat, m.lon]);
  if (S.lat != null) pts.push([S.lat, S.lon]);
  if (pts.length === 1) S.map.setView(pts[0], 17);
  else if (pts.length > 1) S.map.fitBounds(L.latLngBounds(pts).pad(0.25));
  drawUser();
  setSheetIdle();
  setTimeout(() => S.map.invalidateSize(), 150);
}

function drawStops() {
  Object.values(S.stopLayers).forEach((l) => {
    S.map.removeLayer(l.marker); S.map.removeLayer(l.bleed);
    S.map.removeLayer(l.dropoff); S.map.removeLayer(l.highpoint);
  });
  S.stopLayers = {};

  S.currentStops.forEach((m, i) => {
    const ll = [m.lat, m.lon];
    const bleed = L.circle(ll, { radius: m.bleed_radius_m || 40, color: '#6EDFE3', weight: 1.5, dashArray: '4 5', opacity: 0.55, fillOpacity: 0 }).addTo(S.map);
    const dropoff = L.circle(ll, { radius: m.dropoff_radius_m || 25, color: '#6EDFE3', weight: 1.5, opacity: 0.55, fillColor: '#6EDFE3', fillOpacity: 0.1 }).addTo(S.map);
    const highpoint = L.circle(ll, { radius: m.highpoint_radius_m || 12, color: '#6EDFE3', weight: 0, fillColor: '#6EDFE3', fillOpacity: 0.18 }).addTo(S.map);
    const marker = L.marker(ll, {
      icon: L.divIcon({
        className: 'stop-icon',
        html: `<div class="stop-marker-wrap">
          <div class="stop-label" id="label-${m.id}">${esc(m.title)}</div>
          <div class="stop-dot" id="dot-${m.id}">${i + 1}</div>
        </div>`,
        iconSize: [46, 46], iconAnchor: [23, 23],
      }),
    }).addTo(S.map);
    marker.on('click', () => onStopMarkerClick(m.id));
    S.stopLayers[m.id] = { marker, bleed, dropoff, highpoint };
  });
}

function drawUser() {
  if (!S.map || S.lat == null) return;
  const ll = [S.lat, S.lon];
  if (!S.userMarker) {
    S.userMarker = L.marker(ll, {
      icon: L.divIcon({ className: '', html: '<div class="gps-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      zIndexOffset: 1000, interactive: false,
    }).addTo(S.map);
  } else {
    S.userMarker.setLatLng(ll);
  }
}

function onStopMarkerClick(id) {
  const m = S.markersById[id];
  if (!m) return;
  const dist = S.lat != null ? haversine(S.lat, S.lon, m.lat, m.lon) : Infinity;
  if (dist <= (m.bleed_radius_m || 40)) {
    S.dismissedStopId = null;
    setActiveStop(id, dist);
  } else {
    toast('Walk closer to reveal this stop');
  }
}

/* ═══════════════ proximity / audio zones ═══════════════ */
function zoneState(m, dist) {
  if (dist <= (m.highpoint_radius_m || 12)) return 'peak';
  if (dist <= (m.dropoff_radius_m || 25)) return 'dropoff';
  if (dist <= (m.bleed_radius_m || 40)) return 'bleed';
  return 'idle';
}
function zoneVolume(m, dist, state) {
  if (state === 'peak') return 1;
  if (state === 'dropoff') {
    const t = 1 - (dist - m.highpoint_radius_m) / Math.max(1, m.dropoff_radius_m - m.highpoint_radius_m);
    return DROPOFF_VOL + (1 - DROPOFF_VOL) * Math.max(0, Math.min(1, t));
  }
  if (state === 'bleed') {
    const t = 1 - (dist - m.dropoff_radius_m) / Math.max(1, m.bleed_radius_m - m.dropoff_radius_m);
    return DROPOFF_VOL * Math.max(0, Math.min(1, t));
  }
  return 0;
}

function checkZones() {
  if (S.lat == null || !S.currentStops.length) return;
  let nearest = null, nearestDist = Infinity;
  let bestActive = null, bestActiveDist = Infinity;

  S.currentStops.forEach((m) => {
    const dist = haversine(S.lat, S.lon, m.lat, m.lon);
    if (dist < nearestDist) { nearestDist = dist; nearest = m; }
    const state = zoneState(m, dist);
    paintStopMarker(m.id, state === 'idle' ? 'idle' : (state === 'bleed' ? 'approaching' : 'active'), state);

    if (m.id === S.dismissedStopId && state === 'idle') S.dismissedStopId = null; // left, can re-trigger later
    if (state !== 'idle' && dist < bestActiveDist) { bestActiveDist = dist; bestActive = m; }
  });

  const suppressed = bestActive && bestActive.id === S.dismissedStopId;

  if (bestActive && !suppressed) {
    if (S.activeStopId !== bestActive.id) setActiveStop(bestActive.id, bestActiveDist);
    else updateActiveVolume(bestActive, bestActiveDist);
  } else if (S.activeStopId) {
    const active = S.markersById[S.activeStopId];
    const activeDist = active ? haversine(S.lat, S.lon, active.lat, active.lon) : Infinity;
    if (activeDist > (active?.bleed_radius_m || 40) * EXIT_HYSTERESIS) {
      clearActiveStop();
    }
  } else {
    updateIdleSheet(nearest, nearestDist);
  }
}

function paintStopMarker(id, cls, zoneStateName) {
  const dot = document.getElementById('dot-' + id);
  if (dot) {
    dot.className = 'stop-dot' + (cls === 'idle' ? '' : ' ' + cls);
    dot.textContent = S.currentStops.findIndex((s) => s.id === id) + 1;
  }
  const label = document.getElementById('label-' + id);
  if (label) label.classList.toggle('show', cls !== 'idle');
  const layers = S.stopLayers[id];
  if (!layers) return;
  const color = cls === 'active' ? '#46968A' : cls === 'approaching' ? '#8BD03F' : '#6EDFE3';
  layers.bleed.setStyle({ color, opacity: zoneStateName === 'bleed' ? 0.8 : 0.35 });
  layers.dropoff.setStyle({ color, fillColor: color, opacity: 0.5, fillOpacity: zoneStateName === 'dropoff' || zoneStateName === 'peak' ? 0.16 : 0.06 });
  layers.highpoint.setStyle({ fillColor: color, fillOpacity: zoneStateName === 'peak' ? 0.28 : 0.12 });
}

/* ═══════════════ sheet: idle ═══════════════ */
function setSheetIdle() {
  S.activeStopId = null;
  S.expanded = false;
  $('sheetStop').classList.remove('expanded');
  $('sheetStop').style.display = 'none';
  $('sheetIdle').style.display = 'block';
  updateIdleSheet();
}

function updateIdleSheet(nearest, dist) {
  if (S.activeStopId) return;
  const sub = $('sheetIdleSub');
  if (S.gpsDenied) { sub.textContent = 'Location access is off — enable it in your browser settings.'; return; }
  if (S.lat == null) { sub.textContent = 'Locating your position…'; return; }
  if (nearest && isFinite(dist)) { sub.textContent = `${prettyDist(dist)} to “${nearest.title}”.`; return; }
  sub.textContent = 'Walk toward a marker.';
}

/* ═══════════════ sheet: active stop ═══════════════ */
function setActiveStop(id, dist) {
  const m = S.markersById[id];
  if (!m) return;
  S.activeStopId = id;
  S.expanded = false;
  $('sheetIdle').style.display = 'none';
  $('sheetStop').style.display = 'flex';
  $('sheetStop').classList.remove('expanded');

  $('stopTitle').textContent = m.title || '';
  $('stopExcerpt').textContent = m.excerpt || '';
  $('sheetBody').textContent = m.description || '';

  bindAudio(m);
  updateActiveVolume(m, dist ?? 0);
}

function clearActiveStop() {
  stopAudio();
  setSheetIdle();
}

function updateActiveVolume(m, dist) {
  const state = zoneState(m, dist);
  paintStopMarker(m.id, state === 'idle' ? 'idle' : (state === 'bleed' ? 'approaching' : 'active'), state);
  if (S.audio && S.audio.dataset.stopId === m.id) {
    S.audio.volume = zoneVolume(m, dist, state);
  }
}

/* ═══════════════ audio ═══════════════ */
function unlockAudio() {
  if (S.unlocked) return;
  try {
    const a = new Audio();
    a.src = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8dcAUpsPSCA6gAo/YeUAB0oUFTQEQAAAAdRTuI0DwAAAA//tSxCEAB8AhSmxhIIEVCSiJrDCQAAAAAAAAAAAAAAAAAA==';
    a.volume = 0;
    const p = a.play();
    if (p && p.then) p.then(() => a.pause()).catch(() => {});
    S.unlocked = true;
  } catch (e) {}
}

function stopAudio() {
  if (S.audio) { S.audio.pause(); S.audio.src = ''; S.audio = null; }
}

function bindAudio(m) {
  if (S.audio && S.audio.dataset.stopId === m.id) { paintIcon(!S.audio.paused); return; }
  stopAudio();
  if (!m.audio_url) {
    $('durTime').textContent = '0:00';
    $('curTime').textContent = '0:00';
    $('progressFill').style.width = '0%';
    paintIcon(false);
    return;
  }
  const a = new Audio(m.audio_url);
  a.dataset.stopId = m.id;
  a.preload = 'auto';
  a.volume = 0;
  a.addEventListener('loadedmetadata', () => { $('durTime').textContent = fmtTime(a.duration); });
  a.addEventListener('timeupdate', () => paintProgress(a));
  a.addEventListener('ended', () => paintIcon(false));
  a.addEventListener('error', () => toast('Could not load this stop’s audio'));
  S.audio = a;
  const p = a.play();
  if (p && p.catch) p.catch(() => paintIcon(false));
  paintIcon(true);
}

function paintIcon(playing) {
  const ic = $('playIcon');
  ic.className = 'play-icon ' + (playing ? 'playing' : 'paused');
}
function paintProgress(a) {
  const pct = a.duration ? (a.currentTime / a.duration) * 100 : 0;
  $('progressFill').style.width = pct + '%';
  $('curTime').textContent = fmtTime(a.currentTime);
}

$('btnPlayStop').onclick = (e) => {
  e.stopPropagation();
  if (!S.audio) return;
  if (S.audio.paused) { S.audio.play(); paintIcon(true); }
  else { S.audio.pause(); paintIcon(false); }
};

$('progressFill').parentElement.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!S.audio || !S.audio.duration) return;
  const r = e.currentTarget.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  S.audio.currentTime = pct * S.audio.duration;
  paintProgress(S.audio);
});

$('btnCloseStop').onclick = (e) => {
  e.stopPropagation();
  S.dismissedStopId = S.activeStopId;
  clearActiveStop();
};

function toggleExpand() {
  S.expanded = !S.expanded;
  $('sheetStop').classList.toggle('expanded', S.expanded);
}
$('sheetStopHead').addEventListener('click', toggleExpand);
$('sheetMore').addEventListener('click', toggleExpand);

/* ═══════════════ start ═══════════════ */
window.addEventListener('load', boot);
['pointerdown', 'touchstart', 'keydown'].forEach((ev) =>
  window.addEventListener(ev, unlockAudio, { once: true, passive: true })
);
