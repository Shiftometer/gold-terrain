/* Gold Terrain — appli téléphone hors ligne. Voir docs/CONCEPTION_GOLD_TERRAIN.md.
   L'appli n'écrit aucun contenu de fond : elle affiche le lot préparé et contrôlé par Python.
   Ce que l'utilisateur crée (points, photos, traces, journal) reste sur le téléphone, dans des
   magasins que les mises à jour des données ne touchent jamais, jusqu'à ce qu'il l'envoie lui-même. */
'use strict';

const APP_FORMAT = 2;                       // format de lot compris (comparé à app_min_version)
const SITE_FORMAT = 'gold-terrain/1';
const LOT_FORMAT = 'gold-terrain-lot/2';
const DB_NAME = 'gold-terrain';
const DB_VERSION = 2;
const STORES = ['etat', 'perso', 'traces', 'journal'];
const DATA_CACHE = 'gold-terrain-donnees';
const DATA_PREFIX = './_donnees/';
const STALE_DAYS = 7;
const MIN_ITERATIONS = 100000;
const MAGIC = [0x47, 0x54, 0x45, 0x31];      // « GTE1 »
const JOURNAL_FORMAT = 'gold-journal-terrain/1';
const JOURNAL_FIELDS = [
  ['date', 'Date', 'date'],
  ['zone', 'Zone', 'text'],
  ['autorisation', 'Autorisation utilisée (40E, permission écrite, Miner’s Right…)', 'text'],
  ['autorisation_reference', 'Référence de l’autorisation', 'text'],
  ['lieu_exact', 'Lieu exact (reste privé)', 'textarea'],
  ['appareil', 'Appareil et réglages', 'textarea'],
  ['sol', 'Nature du sol', 'textarea'],
  ['resultat', 'Résultat', 'textarea'],
  ['outil_manque', 'Ce que l’outil n’avait pas dit', 'textarea'],
  ['notes', 'Notes', 'textarea'],
];
const SOILS = ['latérite', 'quartz', 'alluvions', 'calcrète', 'argile', 'sable', 'roche en place', 'autre'];
const CATEGORIES = {
  trou: { label: 'Trou ou ancien chantier repéré', color: '#8e5a2b' },
  trouvaille: { label: 'Trouvaille', color: '#d4a017' },
  vehicule: { label: 'Véhicule ou campement', color: '#1f8a4c' },
  danger: { label: 'Danger (puits, fosse…)', color: '#d62828' },
  autre: { label: 'Autre', color: '#6c6c6c' },
};
const KIND_LABELS = {
  collier: 'Sondage',
  centre_secteur: 'Centre de secteur',
  centre_groupe: 'Groupe de proximité',
  verification: 'Point à vérifier',
};
const VECTOR_LAYERS = ['geologie', 'regolithe', 'mines'];

const $ = (id) => document.getElementById(id);
const encoder = new TextEncoder();
let currentLot = null;
let currentVersion = null;
let mapInstance = null;
let geolocate = null;
let locating = false;
let lastPosition = null;
let lastPositionAt = 0;
let panelStack = [];
let traceWatch = null;
let currentTrace = null;
let vehicleWatch = null;
let headingHandler = null;
let preparedShare = null;
const visible = { titres: true, gold: true, perso: true, mines: true, geologie: false, regolithe: false,
  relief: false, changements: false, frise: false };
let basemap = 'carte';
let friseYears = [];
let pmProtocol = null;
let photoUrls = [];
let pmPointer = null;
const pmLoaded = new Set();

// --- Petites aides ------------------------------------------------------------------------------

function show(screen) {
  for (const id of ['ecran-installation', 'ecran-phrase', 'ecran-attente', 'ecran-carte']) {
    $(id).hidden = id !== screen;
  }
}

function waiting(message, progress) {
  show('ecran-attente');
  $('attente-message').textContent = message;
  $('attente-erreur').textContent = '';
  $('attente-reessayer').hidden = true;
  $('attente-barre').style.width = `${Math.round((progress || 0) * 100)}%`;
}

function waitingError(message) {
  show('ecran-attente');
  $('attente-erreur').textContent = message;
  $('attente-reessayer').hidden = false;
}

function notify(message, action) {
  const box = $('notification');
  box.textContent = message;
  if (action) {
    const button = el('button', { type: 'button', className: 'bouton-secondaire sombre' }, action.label);
    button.addEventListener('click', action.run);
    box.appendChild(button);
  }
  box.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { box.hidden = true; }, action ? 20000 : 6000);
}

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function button(label, run, className) {
  const node = el('button', { type: 'button', className: className || 'bouton-secondaire' }, label);
  node.addEventListener('click', run);
  return node;
}

function normalizeSecret(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeSearch(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

function b64(text) {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${hex(crypto.getRandomValues(new Uint8Array(4)))}`;
}

function formatDate(iso) {
  if (!iso) return 'inconnue';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function ageInDays(isoDate) {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const then = Date.UTC(y, m - 1, d);
  const now = new Date();
  const now0 = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((now0 - then) / 86400000);
}

function distanceMetres(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

function bearingDegrees(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad);
  const x = Math.cos(a[1] * rad) * Math.sin(b[1] * rad)
    - Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

function formatCoords(lonlat) {
  return `${lonlat[1].toFixed(5)}, ${lonlat[0].toFixed(5)}`;
}

function xmlEscape(text) {
  return String(text ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

class UserError extends Error {}
class MissingData extends Error {}

// --- Stockage (IndexedDB) -----------------------------------------------------------------------
// « etat » : clé d'enveloppe, pointeur vers les données en place. « perso », « traces », « journal » :
// ce que l'utilisateur crée. Les mises à jour des données n'écrivent que dans « etat » et le cache.

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { dbPromise = null; reject(request.error); };
      request.onblocked = () => notify('Une autre fenêtre de Gold Terrain est ouverte : la fermer pour continuer.');
    });
  }
  return dbPromise;
}

async function dbGet(key, store = 'etat') {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbSet(key, value, store = 'etat') {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function dbDelete(key, store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

// --- Chiffrement --------------------------------------------------------------------------------

async function deriveKekBits(phrase, kdf) {
  if (kdf.alg !== 'PBKDF2-SHA-256' || !(kdf.iterations >= MIN_ITERATIONS)) {
    throw new UserError('Paramètres de chiffrement inattendus : publication à vérifier.');
  }
  const base = await crypto.subtle.importKey('raw', encoder.encode(normalizeSecret(phrase)), 'PBKDF2',
    false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64(kdf.salt), iterations: kdf.iterations, hash: 'SHA-256' }, base, 256);
}

function importKek(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['unwrapKey']);
}

async function storeKek(raw, kek) {
  // On garde de préférence une clé non exportable. Si ce téléphone refuse de la ranger dans
  // IndexedDB, on garde ses octets : les données déchiffrées sont de toute façon sur l'appareil.
  try {
    await dbSet('cle', kek);
  } catch (err) {
    await dbSet('cle', new Uint8Array(raw));
  }
}

async function loadKek() {
  const stored = await dbGet('cle');
  if (!stored) return null;
  if (stored instanceof CryptoKey) return stored;
  return importKek(stored);
}

function unwrapDataKey(record, kek) {
  return crypto.subtle.unwrapKey('raw', b64(record.wrapped), kek,
    { name: 'AES-GCM', iv: b64(record.iv), additionalData: encoder.encode(record.aad) },
    { name: 'AES-GCM' }, false, ['decrypt']);
}

function chunkAad(name, index, count, size) {
  const nameBytes = encoder.encode(name);
  const out = new Uint8Array(4 + nameBytes.length + 16);
  out.set(MAGIC, 0);
  out.set(nameBytes, 4);
  const view = new DataView(out.buffer, 4 + nameBytes.length);
  view.setUint32(0, index, true);
  view.setUint32(4, count, true);
  view.setBigUint64(8, BigInt(size), true);
  return out;
}

async function decryptFile(buffer, key, name) {
  const bytes = new Uint8Array(buffer);
  if (MAGIC.some((b, i) => bytes[i] !== b)) throw new Error(`Fichier « ${name} » non reconnu.`);
  const view = new DataView(buffer);
  const size = Number(view.getBigUint64(8, true));
  const count = view.getUint32(16, true);
  const parts = [];
  let pos = 20;
  let total = 0;
  for (let index = 0; index < count; index++) {
    const iv = bytes.slice(pos, pos + 12);
    const length = view.getUint32(pos + 12, true);
    const sealed = bytes.subarray(pos + 16, pos + 16 + length);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: chunkAad(name, index, count, size) }, key, sealed);
    parts.push(plain);
    total += plain.byteLength;
    pos += 16 + length;
  }
  if (total !== size || pos !== bytes.length) throw new Error(`Fichier « ${name} » tronqué.`);
  return parts;
}

// --- Téléchargement et installation d'une version ----------------------------------------------
// Règles : un téléchargement se fait dans un dossier neuf (« préfixe ») ; le pointeur « courant »
// ne bascule qu'une fois tout vérifié ; le dossier désigné par le pointeur n'est jamais effacé ;
// les anciens dossiers ne sont effacés qu'au démarrage suivant, quand la carte ne les lit plus.

let lockChain = Promise.resolve();

function withLock(task) {
  const run = lockChain.then(task, task);
  lockChain = run.catch(() => {});
  return run;
}

async function fetchVersion() {
  let response;
  try {
    response = await fetch('version.json', { cache: 'no-store' });
  } catch (err) {
    throw new UserError('Pas de réseau. Se connecter au Wi-Fi puis réessayer.');
  }
  if (!response.ok) throw new UserError(`Le serveur ne répond pas (code ${response.status}).`);
  let version;
  try {
    version = await response.json();
  } catch (err) {
    throw new UserError('Réponse inattendue du réseau (Wi-Fi avec page de connexion ?). Réessayer ailleurs.');
  }
  if (version.format !== SITE_FORMAT) throw new UserError('Publication non reconnue.');
  return version;
}

async function installVersion(version, kek, onProgress) {
  if (version.app_min_version > APP_FORMAT) {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) registration.update();
    throw new UserError('Une nouvelle version de l’appli est nécessaire : la fermer complètement puis la rouvrir avec du réseau.');
  }
  const dataKey = await unwrapDataKey(version.key, kek);
  const cache = await caches.open(DATA_CACHE);
  const prefix = `${version.version}-${hex(crypto.getRandomValues(new Uint8Array(4)))}`;
  const files = {};
  const names = Object.keys(version.files);
  const totalBytes = names.reduce((sum, n) => sum + version.files[n].size, 0);
  let doneBytes = 0;
  try {
    for (const name of names) {
      const file = version.files[name];
      const response = await fetch(file.path, { cache: 'no-store' });
      if (!response.ok) throw new UserError(`Téléchargement interrompu (${name}).`);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== file.size || hex(await crypto.subtle.digest('SHA-256', buffer)) !== file.sha256) {
        throw new UserError(`Fichier « ${name} » incomplet ou altéré : réessayer.`);
      }
      const parts = await decryptFile(buffer, dataKey, name);
      for (let i = 0; i < parts.length; i++) {
        await cache.put(`${DATA_PREFIX}${prefix}/${name}/${i}`, new Response(parts[i]));
      }
      files[name] = { chunks: parts.length, size: parts.reduce((s, p) => s + p.byteLength, 0), kind: file.kind || 'pmtiles' };
      doneBytes += file.size;
      if (onProgress) onProgress(doneBytes / totalBytes);
    }
  } catch (err) {
    await deleteDataExcept(null, prefix);
    if (err && err.name === 'QuotaExceededError') {
      throw new UserError('Plus assez de place sur le téléphone : la version précédente est conservée.');
    }
    throw err;
  }
  const pointer = {
    version: version.version,
    prefix,
    published_at: version.published_at,
    tenement_snapshot_date: version.tenement_snapshot_date,
    files,
  };
  await dbSet('courant', pointer);     // bascule d'un coup vers la nouvelle version
  return pointer;
}

async function deleteDataExcept(keepPrefix, onlyPrefix) {
  const cache = await caches.open(DATA_CACHE);
  for (const request of await cache.keys()) {
    const path = request.url.split('/_donnees/')[1] || '';
    const prefix = path.split('/')[0];
    if (onlyPrefix ? prefix === onlyPrefix : prefix !== keepPrefix) await cache.delete(request);
  }
}

async function readData(pointer, name) {
  const cache = await caches.open(DATA_CACHE);
  const parts = [];
  const info = pointer.files && pointer.files[name];
  if (!info || !pointer.prefix) throw new MissingData(name);
  for (let i = 0; i < info.chunks; i++) {
    const response = await cache.match(`${DATA_PREFIX}${pointer.prefix}/${name}/${i}`);
    if (!response) throw new MissingData(name);
    parts.push(await response.blob());
  }
  return new Blob(parts);
}

// --- Géométrie simple (couches publiques) --------------------------------------------------------

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInGeometry(point, geometry) {
  if (!geometry) return false;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some((rings) => rings.length && pointInRing(point, rings[0])
    && !rings.slice(1).some((hole) => pointInRing(point, hole)));
}

// --- Carte --------------------------------------------------------------------------------------

function baseStyle(lot, pmtilesNames) {
  const lines = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
  const style = {
    version: 8,
    sources: { fond: { type: 'vector', url: 'pmtiles://carte.pmtiles' } },
    layers: [
      { id: 'fond-terre', type: 'background', paint: { 'background-color': '#efe7d6' } },
      { id: 'terre', type: 'fill', source: 'fond', 'source-layer': 'earth', paint: { 'fill-color': '#efe7d6' } },
      { id: 'couvert', type: 'fill', source: 'fond', 'source-layer': 'landcover',
        paint: { 'fill-color': ['match', ['get', 'kind'], 'forest', '#cfdcbc', 'scrub', '#dfe0c2',
          'grassland', '#e4e8c8', 'barren', '#eedfc6', '#e9e2d0'], 'fill-opacity': 0.8 } },
      { id: 'usage', type: 'fill', source: 'fond', 'source-layer': 'landuse',
        paint: { 'fill-color': '#e2d6c2', 'fill-opacity': 0.6 } },
      { id: 'eau', type: 'fill', source: 'fond', 'source-layer': 'water', paint: { 'fill-color': '#a9c9dd' } },
    ],
  };
  for (const name of ['satellite', 'relief']) {
    if (pmtilesNames.includes(name)) {
      style.sources[name] = { type: 'raster', url: `pmtiles://${name}.pmtiles`, tileSize: 256 };
    }
  }
  if (style.sources.satellite) {
    style.layers.push({ id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' } });
  }
  style.layers.push({ id: 'frise-place', type: 'background', paint: { 'background-opacity': 0 } });
  if (style.sources.relief) {
    style.layers.push({ id: 'relief', type: 'raster', source: 'relief', layout: { visibility: 'none' },
      paint: { 'raster-opacity': 0.45 } });
  }
  style.layers.push(
    { id: 'eau-lignes', type: 'line', source: 'fond', 'source-layer': 'water', filter: lines,
      paint: { 'line-color': '#6fa3c6', 'line-width': 1 } },
    { id: 'limites', type: 'line', source: 'fond', 'source-layer': 'boundaries',
      paint: { 'line-color': '#9a8f9e', 'line-width': 1, 'line-dasharray': [3, 2] } },
    { id: 'pistes', type: 'line', source: 'fond', 'source-layer': 'roads',
      filter: ['!', ['in', ['get', 'kind'], ['literal', ['highway', 'major_road']]]],
      paint: { 'line-color': '#a8977a', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.4, 14, 1.6, 17, 3] } },
    { id: 'routes', type: 'line', source: 'fond', 'source-layer': 'roads',
      filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road']]],
      paint: { 'line-color': '#d08a1e', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 12, 2.2, 17, 6] } },
  );
  return style;
}

const PALETTE = ['#e6b8a2', '#b8d4a8', '#a8c4e0', '#e0d0a0', '#d0b0d8', '#a8d8d0', '#e8c0c0', '#c8c8a0',
  '#b0c8b0', '#d8b890', '#a0b8d8', '#e0a8b8'];

function colorFor(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function addDataLayers(map, lot) {
  const vectors = lot.layers?.vectors || {};
  for (const name of ['geologie', 'regolithe']) {
    const layer = vectors[name];
    if (!layer) continue;
    for (const f of layer.data.features) f.properties._couleur = colorFor(f.properties.label || f.properties.code || '');
    map.addSource(name, { type: 'geojson', data: layer.data });
    map.addLayer({ id: name, type: 'fill', source: name, layout: { visibility: visible[name] ? 'visible' : 'none' },
      paint: { 'fill-color': ['get', '_couleur'], 'fill-opacity': 0.45, 'fill-outline-color': '#7a6a55' } });
  }
  map.addSource('titres', { type: 'geojson', data: lot.tenements });
  map.addLayer({ id: 'titres-fond', type: 'fill', source: 'titres',
    paint: { 'fill-color': '#7b2d8b', 'fill-opacity': 0.04 } });
  map.addLayer({ id: 'titres', type: 'line', source: 'titres',
    paint: { 'line-color': ['match', ['get', 'status'], 'pending', '#b0569b', '#7b2d8b'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 14, 2.2],
      'line-dasharray': ['match', ['get', 'status'], 'pending', ['literal', [2, 2]], ['literal', [1, 0]]] } });
  if (vectors.mines) {
    map.addSource('mines', { type: 'geojson', data: vectors.mines.data });
    map.addLayer({ id: 'mines', type: 'circle', source: 'mines',
      paint: { 'circle-color': '#f2c230', 'circle-stroke-color': '#3b2a00', 'circle-stroke-width': 1.5,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 7] } });
  }
  const patches = lot.imagery?.patches || [];
  map.addSource('changements-points', { type: 'geojson', data: { type: 'FeatureCollection', features: patches
    .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat))
    .map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: p })) } });
  map.addLayer({ id: 'changements-points', type: 'circle', source: 'changements-points',
    layout: { visibility: 'none' },
    paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#e4572e', 'circle-stroke-width': 2,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 4, 14, 9] } });
  map.addSource('traces', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'traces', type: 'line', source: 'traces',
    paint: { 'line-color': '#e4572e', 'line-width': 3, 'line-opacity': 0.85 } });
  map.addSource('vers-vehicule', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'vers-vehicule', type: 'line', source: 'vers-vehicule',
    paint: { 'line-color': '#1f8a4c', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
  map.addSource('points', { type: 'geojson', data: lot.points });
  map.addLayer({ id: 'points', type: 'circle', source: 'points', filter: ['!=', ['get', 'kind'], 'verification'],
    paint: {
      'circle-color': ['match', ['get', 'kind'], 'collier', '#7a4a12', 'centre_secteur', '#1f5fa8',
        'centre_groupe', '#6b45b0', '#555555'],
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        9, ['match', ['get', 'kind'], 'collier', 3, 5],
        15, ['match', ['get', 'kind'], 'collier', 7, 10]],
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'verification', type: 'circle', source: 'points', filter: ['==', ['get', 'kind'], 'verification'],
    paint: { 'circle-color': '#ffffff', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 5, 15, 11],
      'circle-stroke-color': '#c0392b', 'circle-stroke-width': 3 } });
  map.addSource('perso', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'perso', type: 'circle', source: 'perso',
    paint: { 'circle-color': ['get', 'couleur'], 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 6, 15, 11],
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
  applyVisibility();
}

function setVisibility(layer, on) {
  if (mapInstance?.getLayer(layer)) mapInstance.setLayoutProperty(layer, 'visibility', on ? 'visible' : 'none');
}

function applyVisibility() {
  if (!mapInstance) return;
  setVisibility('titres', visible.titres);
  setVisibility('titres-fond', visible.titres);
  setVisibility('points', visible.gold);
  setVisibility('verification', visible.gold);
  setVisibility('perso', visible.perso);
  for (const name of ['mines', 'geologie', 'regolithe', 'relief']) setVisibility(name, visible[name]);
  setVisibility('changements-points', visible.changements);
  const sat = basemap === 'satellite';
  setVisibility('satellite', sat);
  for (const layer of ['terre', 'couvert', 'usage', 'eau']) setVisibility(layer, !sat);
  showFrise(visible.frise);
}

async function ensurePmtiles(name) {
  // Les images d'une année ne sont lues dans le stockage qu'au moment où on les affiche.
  if (pmLoaded.has(name)) return;
  const file = new File([await readData(pmPointer, name)], `${name}.pmtiles`);
  pmProtocol.add(new pmtiles.PMTiles(new pmtiles.FileSource(file)));
  pmLoaded.add(name);
}

let friseRequest = 0;

async function showFrise(on) {
  const map = mapInstance;
  if (!map) return;
  $('frise-curseur').hidden = !on || !friseYears.length;
  const request = ++friseRequest;
  if (!on || !friseYears.length) {
    if (map.getLayer('frise')) map.removeLayer('frise');
    return;
  }
  const index = Number($('frise-annee').value) || 0;
  const year = friseYears[Math.min(index, friseYears.length - 1)];
  $('frise-annee-texte').textContent = String(year);
  const source = `frise-${year}`;
  try {
    await ensurePmtiles(source);
  } catch (err) {
    notify(`Images de ${year} illisibles sur ce téléphone.`);
    return;
  }
  if (request !== friseRequest) return;        // l'utilisateur a déjà choisi une autre année
  if (!map.isStyleLoaded()) {
    // Carte encore en chargement : on réessaie dès qu'elle est prête.
    map.once('idle', () => { if (request === friseRequest) showFrise(visible.frise); });
    return;
  }
  if (map.getLayer('frise')) map.removeLayer('frise');
  // Une seule année gardée en mémoire de tuiles à la fois.
  for (const id of Object.keys(map.getStyle().sources)) {
    if (id.startsWith('frise-') && id !== source) map.removeSource(id);
  }
  if (!map.getSource(source)) map.addSource(source, { type: 'raster', url: `pmtiles://${source}.pmtiles`, tileSize: 256 });
  map.addLayer({ id: 'frise', type: 'raster', source }, 'frise-place');
}

async function refreshPersoLayer() {
  if (!mapInstance?.getSource('perso')) return;
  const points = await dbAll('perso');
  mapInstance.getSource('perso').setData({ type: 'FeatureCollection', features: points.map((p) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { id: p.id, name: p.name, category: p.category, couleur: categoryOf(p.category).color },
  })) });
  await refreshTraceLayer();
  updateBadge();
}

let savedTraces = null;

async function refreshTraceLayer(reload = true) {
  // Pendant une trace, seule la ligne est redessinée : les points et leurs photos ne sont pas relus.
  if (!mapInstance?.getSource('traces')) return;
  if (reload || savedTraces === null) savedTraces = await dbAll('traces');
  const traces = [...savedTraces];
  if (currentTrace) traces.push(currentTrace);
  mapInstance.getSource('traces').setData({ type: 'FeatureCollection', features: traces
    .filter((t) => t.points.length > 1)
    .map((t) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: t.points.map((p) => [p[0], p[1]]) },
      properties: { id: t.id } })) });
}

function featuresAt(map, point, layers) {
  const pad = 18;
  const existing = layers.filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
  if (!existing.length) return [];
  const found = map.queryRenderedFeatures([[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]],
    { layers: existing });
  const scored = found.map((feature) => {
    const projected = map.project(feature.geometry.coordinates);
    return { feature, distance: Math.hypot(projected.x - point.x, projected.y - point.y) };
  }).sort((a, b) => a.distance - b.distance);
  if (!scored.length) return [];
  const limit = scored[0].distance + 8;
  const seen = new Set();
  return scored.filter((s) => s.distance <= limit).map((s) => s.feature).filter((f) => {
    const key = `${f.layer.id}|${f.properties.id || f.properties.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function onMapClick(event) {
  if (!$('pose').hidden) return;
  const map = mapInstance;
  const features = featuresAt(map, event.point, ['perso', 'verification', 'points', 'mines', 'changements-points']);
  if (features.length === 1) openFeature(features[0]);
  else if (features.length > 1) {
    openPanel(() => [
      el('p', { className: 'fiche-type' }, 'Plusieurs points ici'),
      el('h2', {}, 'Choisir un point'),
      el('div', { className: 'liste-choix' }, features.map((f) => button(describeFeature(f), () => openFeature(f), 'choix'))),
    ]);
  } else {
    openHere([event.lngLat.lng, event.lngLat.lat]);
  }
}

function describeFeature(feature) {
  const p = feature.properties;
  if (feature.layer.id === 'perso') return `Mon point : ${p.name || categoryOf(p.category).label}`;
  if (feature.layer.id === 'mines') return `Mine : ${p.label || p.name || 'sans nom'}`;
  if (feature.layer.id === 'changements-points') return `Changement de ${p.change_year}`;
  return `${KIND_LABELS[p.kind] || p.kind} : ${p.name}`;
}

function openFeature(feature) {
  const p = feature.properties;
  if (feature.layer.id === 'perso') return openPersoPoint(p.id);
  if (feature.layer.id === 'mines') return openPanel(() => vectorInfo('Mine ou gisement', p, currentLot.layers.vectors.mines));
  if (feature.layer.id === 'changements-points') return openPanel(() => changeInfo(p));
  return openSection(p.section, null, { ...p, coordinates: feature.geometry.coordinates });
}

// --- Panneau (fiches, dossier, couches, points, journal…) ---------------------------------------

function openPanel(render, options = {}) {
  if (!options.replace && !$('panneau').hidden && panelStack.length) panelStack.push(render);
  else panelStack = [render];
  renderPanel();
}

function renderPanel() {
  const render = panelStack[panelStack.length - 1];
  const content = $('panneau-contenu');
  content.replaceChildren(...[].concat(render()).filter(Boolean));
  content.scrollTop = 0;
  $('panneau').scrollTop = 0;
  $('panneau-retour').hidden = panelStack.length < 2;
  freshness($('panneau-fraicheur'));
  $('panneau').hidden = false;
}

function closePanel() {
  $('panneau').hidden = true;
  panelStack = [];
}

function backPanel() {
  if (panelStack.length > 1) {
    panelStack.pop();
    renderPanel();
  }
}

function openSection(sid, inner, point) {
  const section = currentLot.sections[sid];
  if (!section) {
    notify('Fiche introuvable dans ces données.');
    return;
  }
  openPanel(() => {
    const body = el('div', { className: 'fiche-contenu' });
    body.innerHTML = section.html;       // texte produit et échappé par Python (fieldpack_html)
    wireLinks(body);
    const nodes = [];
    if (point) {
      nodes.push(el('p', { className: 'fiche-type' }, KIND_LABELS[point.kind] || ''));
      const coords = point.coordinates || null;
      if (coords) nodes.push(el('p', { className: 'petit' }, formatCoords(coords)));
    }
    nodes.push(el('h2', {}, section.title), body);
    if (inner) {
      setTimeout(() => {
        const target = document.getElementById(inner);
        if (target) target.scrollIntoView({ block: 'start' });
      }, 50);
    }
    return nodes;
  });
}

function wireLinks(root) {
  for (const link of root.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (href.startsWith('#')) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const target = decodeURIComponent(href.slice(1));
        const sid = target.split('.')[0];
        if (sid === 'journal') return openJournal();
        openSection(sid, target.includes('.') ? target : null);
      });
    } else if (href.startsWith('https://')) {
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.title = 'Lien officiel : demande du réseau';
    }
  }
}

function openDossier() {
  openPanel(() => {
    const input = el('input', { type: 'search', placeholder: 'Nom d’un sondage ou d’un secteur (MOAC064…)',
      autocomplete: 'off', spellcheck: false });
    const list = el('div', { className: 'dossier-liste' });
    const renderList = () => {
      const q = normalizeSearch(input.value);
      list.replaceChildren();
      let group = null;
      let count = 0;
      for (const entry of currentLot.summary) {
        const text = normalizeSearch(`${entry.label} ${entry.search || ''}`);
        if (q && !text.includes(q)) continue;
        if (entry.group !== group) {
          group = entry.group;
          list.append(el('h3', {}, group));
        }
        list.append(button(entry.label, () => openSection(entry.section), 'choix'));
        count += 1;
        if (q && count >= 60) break;
      }
      if (!count) list.append(el('p', { className: 'petit' }, 'Aucune fiche de ce nom.'));
    };
    input.addEventListener('input', renderList);
    renderList();
    return [el('h2', {}, 'Dossier de la zone'), input, list];
  });
}

function openHere(lonlat) {
  openPanel(() => {
    const nodes = [el('p', { className: 'fiche-type' }, 'Ici'), el('h2', {}, formatCoords(lonlat))];
    const titles = currentLot.tenements.features.filter((f) => pointInGeometry(lonlat, f.geometry));
    nodes.push(el('h3', {}, 'Titres miniers'));
    const [zw, zs, ze, zn] = currentLot.zone.bbox;
    const insideZone = lonlat[0] >= zw && lonlat[0] <= ze && lonlat[1] >= zs && lonlat[1] <= zn;
    if (!insideZone) {
      // Le relevé n'a gardé que les titres qui touchent la zone : ailleurs, on ne sait pas.
      nodes.push(el('p', { className: 'avertissement' }, 'Hors de la zone du relevé : les titres miniers de cet endroit ne sont pas dans l’appli. Vérifier sur TENGRAPH.'));
    } else if (!currentLot.tenement_snapshot.date) {
      nodes.push(el('p', { className: 'avertissement' }, 'Aucun relevé des titres dans ces données.'));
    } else if (!titles.length) {
      nodes.push(el('p', {}, `Aucun titre du relevé du ${formatDate(currentLot.tenement_snapshot.date)} ne touche ce point. Ce n’est pas une autorisation : vérifier sur TENGRAPH le jour même.`));
    }
    for (const t of titles) {
      const p = t.properties;
      nodes.push(el('div', { className: 'carte-info' },
        el('strong', {}, p.tenement_id), ` — ${p.type || ''}, ${p.status_label} (${p.statut_au})`,
        el('br'), el('span', { className: 'src' }, (p.holders || []).join(' ; ')),
        el('br'), button('Démarche et fiche du titre', () => openSection('titres', p.anchor), 'lien')));
    }
    const vectors = currentLot.layers?.vectors || {};
    for (const [name, title] of [['geologie', 'Géologie'], ['regolithe', 'Régolithe']]) {
      const layer = vectors[name];
      if (!layer) continue;
      const hit = layer.data.features.find((f) => pointInGeometry(lonlat, f.geometry));
      nodes.push(el('h3', {}, title));
      nodes.push(hit ? propertyBlock(hit.properties, layer) : el('p', { className: 'petit' }, 'Pas de polygone ici dans cette couche.'));
    }
    if (vectors.mines) {
      let best = null;
      for (const f of vectors.mines.data.features) {
        if (f.geometry?.type !== 'Point') continue;
        const d = distanceMetres(lonlat, f.geometry.coordinates);
        if (!best || d < best.d) best = { d, f };
      }
      nodes.push(el('h3', {}, 'Mine ou gisement le plus proche'));
      nodes.push(best ? el('div', {}, el('p', {}, `${formatDistance(best.d)} : `), propertyBlock(best.f.properties, vectors.mines))
        : el('p', { className: 'petit' }, 'Aucun dans cette couche.'));
    }
    if (!Object.keys(vectors).length) {
      nodes.push(el('p', { className: 'petit' }, 'Géologie, régolithe et mines : couches pas encore ajoutées à cette publication.'));
    }
    nodes.push(el('div', { className: 'ligne-boutons' },
      button('Poser un point ici', () => { closePanel(); editPersoPoint(null, lonlat); }, 'bouton-principal')));
    return nodes;
  });
}

function propertyBlock(props, layer) {
  const rows = Object.entries(props).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== '' && typeof v !== 'object');
  return el('div', { className: 'carte-info' },
    el('dl', {}, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', { className: 'src' }, String(v))])),
    el('p', { className: 'petit' }, `Source : ${layer.source || 'non renseignée'}${layer.date ? `, ${layer.date}` : ''}${layer.licence ? `, ${layer.licence}` : ''}.`));
}

function vectorInfo(title, props, layer) {
  return [el('p', { className: 'fiche-type' }, title), el('h2', {}, props.label || props.name || 'Sans nom'),
    propertyBlock(props, layer)];
}

function changeInfo(p) {
  return [el('p', { className: 'fiche-type' }, 'Changement visible sur les images'),
    el('h2', {}, `Vers ${p.change_year}`),
    el('p', {}, `Surface : ${p.area_ha} ha. Sol nu avant : ${p.bare_soil_before} %, après : ${p.bare_soil_after} %. Changement ${p.persistence}.`),
    el('p', { className: 'petit' }, 'Calcul automatique sur les images Landsat annuelles (30 m) : un pixel couvre environ un terrain de football. Les trous de détecteurs ne se voient pas à cette échelle. À interpréter avec la frise des années.')];
}

function freshness(element) {
  if (!element) return;
  const date = currentLot?.tenement_snapshot?.date;
  const age = ageInDays(date);
  element.classList.remove('ancien');
  if (!currentLot) {
    element.textContent = '';
  } else if (!date) {
    element.textContent = 'Aucun relevé des titres miniers dans ces données.';
    element.classList.add('ancien');
  } else if (!Number.isFinite(age) || age < 0) {
    element.textContent = `Date du relevé des titres douteuse (${date}) : vérifier sur TENGRAPH avant toute sortie.`;
    element.classList.add('ancien');
  } else if (age > STALE_DAYS) {
    element.textContent = `Relevé des titres du ${formatDate(date)}, il y a ${age} jours : trop ancien. Mettre à jour avec du réseau, et vérifier sur TENGRAPH.`;
    element.classList.add('ancien');
  } else {
    element.textContent = `Titres miniers : statut au ${formatDate(date)}.`;
  }
}

// --- Couches ------------------------------------------------------------------------------------

function openLayers() {
  openPanel(() => {
    const vectors = currentLot.layers?.vectors || {};
    const rasters = currentLot.layers?.rasters || {};
    const nodes = [el('h2', {}, 'Couches')];
    const fond = el('div', { className: 'ligne-boutons' });
    for (const [value, label, available] of [['carte', 'Carte', true], ['satellite', 'Satellite', !!rasters.satellite]]) {
      if (!available) continue;
      fond.append(button(label, () => { basemap = value; applyVisibility(); renderPanel(); },
        basemap === value ? 'bouton-principal' : 'bouton-secondaire'));
    }
    nodes.push(el('h3', {}, 'Fond'), fond);
    if (!rasters.satellite) nodes.push(el('p', { className: 'petit' }, 'Satellite : pas encore ajouté à cette publication.'));
    const toggles = [['titres', 'Titres miniers', true], ['gold', 'Sondages et secteurs Gold', true],
      ['perso', 'Mes points et traces', true], ['mines', vectors.mines?.label || 'Mines et gisements', !!vectors.mines],
      ['geologie', vectors.geologie?.label || 'Géologie', !!vectors.geologie],
      ['regolithe', vectors.regolithe?.label || 'Régolithe', !!vectors.regolithe],
      ['relief', rasters.relief?.label || 'Relief', !!rasters.relief],
      ['changements', 'Changements durables visibles sur les images', !!(currentLot.imagery?.patches || []).length],
      ['frise', 'Frise des années (Landsat)', friseYears.length > 0]];
    const list = el('div', { className: 'bascules' });
    for (const [key, label, available] of toggles) {
      const box = el('input', { type: 'checkbox', checked: available && !!visible[key], disabled: !available });
      box.addEventListener('change', () => { visible[key] = box.checked; applyVisibility(); });
      list.append(el('label', { className: available ? 'bascule' : 'bascule indisponible' }, box,
        ` ${label}${available ? '' : ' (pas encore ajoutée)'}`));
    }
    nodes.push(el('h3', {}, 'Afficher'), list);
    const imagery = currentLot.imagery;
    if (imagery?.patches?.length) {
      nodes.push(el('h3', {}, 'Plus grands changements visibles'));
      const rule = imagery.change_rule;
      if (rule) {
        nodes.push(el('p', { className: 'petit' }, `${rule.shown} changements durables montrés sur ${rule.detected_total} détectés : les autres sont surtout des variations de végétation, visibles dans la frise des années.`));
      }
      const top = [...imagery.patches].sort((a, b) => b.area_ha - a.area_ha).slice(0, 8);
      nodes.push(el('div', {}, top.map((p) => button(`${p.change_year} · ${p.area_ha} ha · ${p.persistence}`,
        () => { closePanel(); visible.changements = true; applyVisibility(); mapInstance.flyTo({ center: [p.lon, p.lat], zoom: 14 }); }, 'choix'))));
    }
    nodes.push(el('p', { className: 'petit' }, (currentLot.attributions || []).join(' · ')));
    return nodes;
  });
}

// --- Mes points ---------------------------------------------------------------------------------

function startPlacing() {
  closePanel();
  $('viseur').hidden = false;
  $('pose').hidden = false;
}

function stopPlacing() {
  $('viseur').hidden = true;
  $('pose').hidden = true;
}

function setPosition(coords) {
  lastPosition = [coords.longitude, coords.latitude];
  lastPositionAt = Date.now();
}

function currentPositionOnce() {
  return new Promise((resolve, reject) => {
    // Une position de plus de 15 secondes ne sert pas à poser un point : on peut avoir roulé depuis.
    if (lastPosition && Date.now() - lastPositionAt < 15000) return resolve(lastPosition);
    if (!navigator.geolocation) return reject(new UserError('Position indisponible sur cet appareil.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => { setPosition(pos.coords); resolve(lastPosition); },
      (err) => reject(new UserError(err.code === 1 ? 'Position refusée : voir Réglages › Confidentialité › Service de localisation.' : 'Position pas encore trouvée : rester à découvert une ou deux minutes.')),
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 10000 });
  });
}

async function editPersoPoint(id, lonlat) {
  const existing = id ? await dbGet(id, 'perso') : null;
  const record = existing || { id: uid('pt'), category: 'trou', name: '', note: '', lon: lonlat[0], lat: lonlat[1],
    created_at: new Date().toISOString(), photos: [], envoye: false };
  const draft = { ...record, photos: [...(record.photos || [])] };
  const save = async () => {
    draft.updated_at = new Date().toISOString();
    draft.envoye = false;
    try {
      await dbSet(draft.id, draft, 'perso');
    } catch (err) {
      notify('Point non enregistré (téléphone plein ?) : libérer de la place puis réessayer.');
      return;
    }
    await refreshPersoLayer();
  };
  openPanel(() => {
    const category = el('select', {}, Object.entries(CATEGORIES).map(([k, v]) => el('option', { value: k, selected: draft.category === k }, v.label)));
    category.addEventListener('change', async () => { draft.category = category.value; await save(); });
    const name = el('input', { type: 'text', value: draft.name, placeholder: 'Nom (facultatif)' });
    name.addEventListener('input', () => { draft.name = name.value; clearTimeout(name.t); name.t = setTimeout(save, 400); });
    const note = el('textarea', { rows: 3, placeholder: 'Note' }, draft.note);
    note.addEventListener('input', () => { draft.note = note.value; clearTimeout(note.t); note.t = setTimeout(save, 400); });
    const photos = el('div', { className: 'photos' });
    for (const url of photoUrls) URL.revokeObjectURL(url);      // libère les aperçus du rendu précédent
    photoUrls = [];
    for (const photo of draft.photos) {
      const url = URL.createObjectURL(new Blob([photo.data], { type: photo.type || 'image/jpeg' }));
      photoUrls.push(url);
      const soil = el('select', {}, el('option', { value: '' }, 'Sol : non précisé'), SOILS.map((s) => el('option', { value: s, selected: photo.sol === s }, `Sol : ${s}`)));
      soil.addEventListener('change', async () => { photo.sol = soil.value; await save(); });
      photos.append(el('figure', {}, el('img', { src: url, alt: 'Photo du point' }), soil,
        button('Supprimer la photo', async () => {
          if (!confirm('Supprimer cette photo du téléphone ?')) return;
          draft.photos = draft.photos.filter((p) => p !== photo);
          await save();
          renderPanel();
        }, 'lien')));
    }
    const addPhoto = button('Ajouter une photo', () => {
      const input = $('photo-fichier');
      input.value = '';
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        try {
          const data = await shrinkPhoto(file);
          draft.photos.push({ id: uid('ph'), type: 'image/jpeg', data, sol: '', taken_at: new Date().toISOString() });
          await save();
          renderPanel();
        } catch (err) {
          notify('Photo illisible : réessayer.');
        }
      };
      input.click();
    });
    return [
      el('p', { className: 'fiche-type' }, 'Mon point'),
      el('h2', {}, draft.name || categoryOf(draft.category).label),
      el('p', { className: 'petit' }, `${formatCoords([draft.lon, draft.lat])} · créé le ${new Date(draft.created_at).toLocaleString('fr-FR')}`),
      el('label', {}, 'Catégorie'), category,
      el('label', {}, 'Nom'), name,
      el('label', {}, 'Note'), note,
      el('h3', {}, 'Photos'), photos, addPhoto,
      el('p', { className: 'petit' }, 'Pour une photo du sol, préciser sa nature : elle servira plus tard à juger ce qu’une IA sait reconnaître.'),
      el('div', { className: 'ligne-boutons' },
        button('Retour vers ce point', () => { closePanel(); guideTo([draft.lon, draft.lat], draft.name || 'ce point'); }),
        button('Supprimer le point', async () => {
          if (!confirm('Supprimer ce point et ses photos du téléphone ?')) return;
          await dbDelete(draft.id, 'perso');
          await refreshPersoLayer();
          closePanel();
        }, 'bouton-danger')),
    ];
  }, { replace: !existing });
  if (!existing) await save();
}

function openPersoPoint(id) {
  editPersoPoint(id);
}

async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  canvas.width = 0;
  canvas.height = 0;
  return blob.arrayBuffer();     // octets plutôt qu'un Blob : plus sûr dans IndexedDB sur iOS
}

// --- Trace --------------------------------------------------------------------------------------

async function toggleTrace() {
  if (traceWatch !== null) {
    navigator.geolocation.clearWatch(traceWatch);
    traceWatch = null;
    if (currentTrace && currentTrace.points.length > 1) {
      currentTrace.ended_at = new Date().toISOString();
      await dbSet(currentTrace.id, currentTrace, 'traces');
      notify(`Trace enregistrée : ${currentTrace.points.length} positions.`);
    }
    currentTrace = null;
    $('trace-indicateur').hidden = true;
    $('bouton-trace').classList.remove('actif');
    await refreshPersoLayer();
    return;
  }
  if (!navigator.geolocation) return notify('Position indisponible sur cet appareil.');
  currentTrace = { id: uid('tr'), started_at: new Date().toISOString(), points: [], envoye: false };
  $('trace-indicateur').hidden = false;
  $('bouton-trace').classList.add('actif');
  notify('Trace en cours. Elle s’enregistre tant que l’appli reste ouverte à l’écran.');
  traceWatch = navigator.geolocation.watchPosition(async (pos) => {
    const p = [pos.coords.longitude, pos.coords.latitude, Date.now()];
    setPosition(pos.coords);
    const last = currentTrace.points[currentTrace.points.length - 1];
    if (!last || distanceMetres(last, p) >= 5) {
      currentTrace.points.push(p);
      if (currentTrace.points.length % 10 === 0) await dbSet(currentTrace.id, currentTrace, 'traces');
      refreshTraceLayer(false);
    }
  }, (err) => {
    if (err.code === 1) {
      notify('Position refusée : la trace ne peut pas s’enregistrer.');
      toggleTrace();
    }
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 60000 });
}

// --- Retour au véhicule (ou vers un point) ------------------------------------------------------

async function openVehicle() {
  const points = (await dbAll('perso')).filter((p) => p.category === 'vehicule')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (!points.length) {
    openPanel(() => [el('h2', {}, 'Retour au véhicule'),
      el('p', {}, 'Aucun point « Véhicule ou campement » pour l’instant. En arrivant, poser un point à sa position.'),
      el('div', { className: 'ligne-boutons' }, button('Poser le véhicule à ma position', async () => {
        try {
          const position = await currentPositionOnce();
          const record = { id: uid('pt'), category: 'vehicule', name: 'Véhicule', note: '', lon: position[0], lat: position[1],
            created_at: new Date().toISOString(), photos: [], envoye: false };
          await dbSet(record.id, record, 'perso');
          await refreshPersoLayer();
          notify('Véhicule enregistré à votre position.');
          closePanel();
        } catch (err) {
          notify(err.message);
        }
      }, 'bouton-principal'))]);
    return;
  }
  const target = points[0];
  guideTo([target.lon, target.lat], target.name || 'le véhicule');
}

function guideTo(target, label) {
  stopGuide();
  const arrow = el('div', { className: 'fleche' }, '↑');
  const distance = el('p', { className: 'guide-distance' }, 'Recherche de la position…');
  const detail = el('p', { className: 'petit' }, '');
  let heading = null;
  const update = () => {
    if (!lastPosition) return;
    const d = distanceMetres(lastPosition, target);
    const b = bearingDegrees(lastPosition, target);
    distance.textContent = `${formatDistance(d)} vers ${label}`;
    detail.textContent = `Cap ${Math.round(b)}°${heading === null ? ' (boussole non activée : la flèche indique le nord en haut)' : ''}.`;
    arrow.style.transform = `rotate(${b - (heading || 0)}deg)`;
    mapInstance?.getSource('vers-vehicule')?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [lastPosition, target] } });
  };
  vehicleWatch = navigator.geolocation?.watchPosition((pos) => {
    setPosition(pos.coords);
    update();
  }, (err) => {
    const text = err.code === 1 ? 'Position refusée : voir Réglages.' : 'Position pas encore trouvée.';
    // Une dernière position connue reste affichée ; l'erreur s'ajoute sans l'effacer.
    if (lastPosition) detail.textContent = `${detail.textContent} ${text} (dernière position connue)`;
    else distance.textContent = text;
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 60000 }) ?? null;
  const compass = button('Activer la boussole', async () => {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const answer = await DeviceOrientationEvent.requestPermission();
        if (answer !== 'granted') return notify('Boussole refusée.');
      }
      headingHandler = (event) => {
        if (typeof event.webkitCompassHeading === 'number') heading = event.webkitCompassHeading;
        else if (event.absolute && typeof event.alpha === 'number') heading = 360 - event.alpha;
        update();
      };
      window.addEventListener('deviceorientation', headingHandler, true);
      compass.hidden = true;
    } catch (err) {
      notify('Boussole indisponible sur cet appareil.');
    }
  });
  openPanel(() => [el('p', { className: 'fiche-type' }, 'Retour'), el('h2', {}, label), arrow, distance, detail, compass,
    el('p', { className: 'petit' }, 'Distance à vol d’oiseau. Ne remplace ni une carte papier ni une balise de détresse.')]);
  update();
  mapInstance?.flyTo({ center: target, zoom: Math.max(mapInstance.getZoom(), 13) });
}

function stopGuide() {
  if (vehicleWatch !== null && vehicleWatch !== undefined) navigator.geolocation.clearWatch(vehicleWatch);
  vehicleWatch = null;
  if (headingHandler) window.removeEventListener('deviceorientation', headingHandler, true);
  headingHandler = null;
  mapInstance?.getSource('vers-vehicule')?.setData({ type: 'FeatureCollection', features: [] });
}

// --- Journal et envoi ---------------------------------------------------------------------------

async function updateBadge() {
  try {
    const pending = (await dbAll('journal')).filter((e) => !e.envoye).length
      + (await dbAll('perso')).filter((p) => !p.envoye).length
      + (await dbAll('traces')).filter((t) => !t.envoye).length;
    $('journal-badge').hidden = pending === 0;
    $('journal-badge').textContent = String(pending);
  } catch (err) { /* sans badge */ }
}

function stamp(record) {
  // Empreinte d'un enregistrement au moment où il est préparé pour l'envoi : s'il change avant la fin du
  // partage, il n'est pas marqué « envoyé ».
  return String(record.updated_at || record.ended_at || record.created_at || '');
}

async function openJournal() {
  // Relu à chaque affichage (y compris au retour d'une sortie) : la liste et l'envoi sont toujours à jour.
  const render = () => {
    const entries = [...journalCache].sort((a, b) => String(b.date || b.created_at).localeCompare(String(a.date || a.created_at)));
    preparedShare = null;
    prepareShare();          // préparé à l'avance : le partage doit suivre le toucher sans attente
    return [
      el('h2', {}, 'Journal de terrain'),
      el('p', { className: 'petit' }, 'Privé : reste sur ce téléphone jusqu’à l’envoi. Envoyer après chaque sortie : si iOS effaçait un jour les données de l’appli, ce qui n’est pas envoyé serait perdu.'),
      el('div', { className: 'ligne-boutons' },
        button('Nouvelle sortie', () => editEntry(null), 'bouton-principal'),
        button('Tout envoyer', shareAll),
        button('Copier le journal', copyJournal),
        button('Importer un GPX', importGpx)),
      el('div', {}, entries.map((e) => button(`${formatDate(e.date) || '—'} · ${e.zone || 'sans zone'}${e.envoye ? '' : ' · non envoyé'}`, () => editEntry(e.uid), 'choix'))),
    ];
  };
  journalCache = await dbAll('journal');
  openPanel(render);
}

let journalCache = [];

function cacheEntry(entry, removed) {
  journalCache = journalCache.filter((e) => e.uid !== entry.uid);
  if (!removed) journalCache.push({ ...entry });
}

async function editEntry(id) {
  const existing = id ? await dbGet(id, 'journal') : null;
  const entry = existing || { uid: uid('j'), created_at: new Date().toISOString(), date: today(),
    zone: currentLot?.zone?.label || '', envoye: false };
  const save = async () => {
    entry.envoye = false;
    entry.updated_at = new Date().toISOString();
    try {
      await dbSet(entry.uid, entry, 'journal');
      cacheEntry(entry);
      updateBadge();
    } catch (err) {
      notify('Enregistrement impossible (téléphone plein ?) : copier le texte ailleurs par sécurité.');
    }
  };
  if (!existing) await save();
  openPanel(() => {
    const nodes = [el('h2', {}, 'Sortie'), el('p', { className: 'petit' }, 'Enregistré à chaque frappe.')];
    for (const [key, label, type] of JOURNAL_FIELDS) {
      const input = type === 'textarea' ? el('textarea', { rows: 3 }, entry[key] || '')
        : el('input', { type, value: entry[key] || '' });
      input.addEventListener('input', () => { entry[key] = input.value; clearTimeout(input.t); input.t = setTimeout(save, 300); });
      nodes.push(el('label', {}, label), input);
      if (key === 'sol') {
        nodes.push(el('div', { className: 'puces' }, SOILS.map((s) => button(s, () => {
          input.value = input.value ? `${input.value}, ${s}` : s;
          entry.sol = input.value;
          save();
        }, 'puce'))));
      }
    }
    nodes.push(el('div', { className: 'ligne-boutons' }, button('Supprimer cette sortie', async () => {
      if (!confirm('Supprimer cette sortie du téléphone ?')) return;
      await dbDelete(entry.uid, 'journal');
      cacheEntry(entry, true);
      updateBadge();
      backPanel();
    }, 'bouton-danger')));
    return nodes;
  });
}

function journalDocument(entries) {
  const fields = JOURNAL_FIELDS.map(([k]) => k);
  return { format: JOURNAL_FORMAT, exported_at: new Date().toISOString(), entries: entries.map((e) => {
    const out = { uid: e.uid, created_at: e.created_at || '' };
    for (const f of fields) out[f] = typeof e[f] === 'string' ? e[f] : '';
    return out;
  }) };
}

function categoryOf(key) {
  return Object.prototype.hasOwnProperty.call(CATEGORIES, key) ? CATEGORIES[key] : CATEGORIES.autre;
}

function photoFileName(point, photo, index) {
  // L'identifiant du point est dans le nom : chaque photo se rattache à son point du fichier GPX.
  const label = (point.name || point.category || 'point').replace(/[^A-Za-z0-9À-ÿ_-]+/g, '-').slice(0, 40);
  return `photo-${point.id}-${label}-${photo.sol || 'sol-non-precise'}-${index + 1}.jpg`.replace(/\s+/g, '-');
}

function gpxDocument(points, traces) {
  const wpts = points.map((p) => {
    const links = (p.photos || []).map((photo, i) => `<link href="${xmlEscape(photoFileName(p, photo, i))}"><text>photo ${i + 1}</text></link>`).join('');
    return `  <wpt lat="${p.lat}" lon="${p.lon}"><time>${xmlEscape(p.created_at)}</time><name>${xmlEscape(p.name || categoryOf(p.category).label)}</name><desc>${xmlEscape(`${categoryOf(p.category).label}${p.note ? ` — ${p.note}` : ''}`)}</desc>${links}<type>${xmlEscape(p.category)}</type><extensions><gold-id>${xmlEscape(p.id)}</gold-id></extensions></wpt>`;
  });
  const trks = traces.filter((t) => t.points.length > 1).map((t) => `  <trk><name>Trace ${xmlEscape(t.started_at)}</name><trkseg>\n${t.points.map((q) => `    <trkpt lat="${q[1]}" lon="${q[0]}"><time>${new Date(q[2]).toISOString()}</time></trkpt>`).join('\n')}\n  </trkseg></trk>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Gold Terrain" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts.concat(trks).join('\n')}\n</gpx>\n`;
}

async function prepareShare() {
  const entries = await dbAll('journal');
  const points = await dbAll('perso');
  const traces = await dbAll('traces');
  const day = today();
  const files = [
    new File([JSON.stringify(journalDocument(entries), null, 2)], `journal-${day}.json`, { type: 'application/json' }),
    new File([gpxDocument(points, traces)], `mes-points-${day}.gpx`, { type: 'application/gpx+xml' }),
  ];
  for (const p of points) {
    (p.photos || []).forEach((photo, i) => {
      files.push(new File([photo.data], photoFileName(p, photo, i), { type: 'image/jpeg' }));
    });
  }
  const snapshot = (list, key) => list.map((r) => [r[key], stamp(r)]);
  preparedShare = { files, ids: { journal: snapshot(entries, 'uid'), perso: snapshot(points, 'id'), traces: snapshot(traces, 'id') } };
}

function shareAll() {
  // Appelé directement par le toucher : aucune attente avant navigator.share (sinon iOS refuse).
  if (!preparedShare) return notify('Préparation en cours, réessayer dans une seconde.');
  const payload = { files: preparedShare.files };      // fichiers seuls : iOS échoue sur fichiers + texte
  const ids = preparedShare.ids;
  if (navigator.canShare && navigator.canShare(payload)) {
    navigator.share(payload).then(() => markSent(ids)).catch((err) => {
      if (err && err.name !== 'AbortError') notify('Partage impossible : utiliser « Copier le journal ».');
    });
  } else {
    notify('Ce téléphone ne partage pas de fichiers depuis l’appli : utiliser « Copier le journal ».');
  }
}

async function markSent(ids) {
  let changed = 0;
  for (const [store, list] of Object.entries(ids)) {
    for (const [key, sentStamp] of list) {
      const record = await dbGet(key, store);
      if (!record) continue;
      if (stamp(record) !== sentStamp) { changed += 1; continue; }   // modifié pendant l'envoi : reste à envoyer
      record.envoye = true;
      await dbSet(key, record, store);
      if (store === 'journal') cacheEntry(record);
    }
  }
  updateBadge();
  notify(changed ? `Envoyé. ${changed} élément(s) modifié(s) entre-temps restent à envoyer.`
    : 'Envoyé. Les données restent aussi sur le téléphone.');
}

async function copyJournal() {
  const text = JSON.stringify(journalDocument(await dbAll('journal')), null, 2);
  try {
    await navigator.clipboard.writeText(text);
    notify('Journal copié : le coller dans un message ou une note.');
  } catch (err) {
    openPanel(() => [el('h2', {}, 'Journal (texte)'), el('p', { className: 'petit' }, 'Sélectionner tout le texte, puis « Copier ».'),
      el('textarea', { rows: 14, readOnly: true }, text)]);
  }
}

function importGpx() {
  const input = $('gpx-fichier');
  input.value = '';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
      const existing = await dbAll('perso');
      const known = new Set(existing.map((p) => `${Number(p.lat).toFixed(6)}|${Number(p.lon).toFixed(6)}|${p.name || ''}`));
      let added = 0;
      let skipped = 0;
      for (const w of [...doc.getElementsByTagName('wpt')]) {
        const lat = Number(w.getAttribute('lat'));
        const lon = Number(w.getAttribute('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const name = w.getElementsByTagName('name')[0]?.textContent || '';
        const key = `${lat.toFixed(6)}|${lon.toFixed(6)}|${name}`;
        if (known.has(key)) { skipped += 1; continue; }       // déjà présent : pas de doublon
        known.add(key);
        const type = w.getElementsByTagName('type')[0]?.textContent || '';
        const time = w.getElementsByTagName('time')[0]?.textContent || '';
        // Un point importé ne devient jamais « Véhicule » : le retour au véhicule ne doit viser que le
        // véhicule posé sur place, pas celui d'une ancienne sortie.
        const category = type !== 'vehicule' && Object.prototype.hasOwnProperty.call(CATEGORIES, type) ? type : 'autre';
        const created = Number.isNaN(Date.parse(time)) ? new Date().toISOString() : new Date(time).toISOString();
        const id = uid('pt');
        await dbSet(id, { id, category, name, note: `Importé d’un GPX${type === 'vehicule' ? ' (ancien véhicule)' : ''}`,
          lon, lat, created_at: created, photos: [], envoye: true }, 'perso');
        added += 1;
      }
      await refreshPersoLayer();
      notify(`${added} point(s) importé(s)${skipped ? `, ${skipped} déjà présent(s)` : ''}.`);
    } catch (err) {
      notify('Fichier GPX illisible.');
    }
  };
  input.click();
}

// --- Rendu de la carte --------------------------------------------------------------------------

async function renderMap(pointer) {
  const lotBlob = await readData(pointer, 'lot');
  const lot = JSON.parse(await lotBlob.text());
  if (lot.format !== LOT_FORMAT) throw new UserError('Données d’un format inconnu : mettre à jour l’appli.');
  const pmtilesNames = Object.entries(pointer.files).filter(([, f]) => f.kind !== 'lot').map(([name]) => name);
  const protocol = new pmtiles.Protocol();
  pmProtocol = protocol;
  pmPointer = pointer;
  pmLoaded.clear();
  for (const name of pmtilesNames.filter((n) => !n.startsWith('frise-'))) await ensurePmtiles(name);
  currentLot = lot;
  currentVersion = pointer;
  friseYears = pmtilesNames.filter((n) => /^frise-\d{4}$/.test(n)).map((n) => Number(n.slice(6))).sort((a, b) => a - b);
  $('frise-annee').max = String(Math.max(0, friseYears.length - 1));
  $('frise-annee').value = String(Math.max(0, friseYears.length - 1));

  $('zone-nom').textContent = lot.zone.label;
  freshness($('fraicheur'));
  show('ecran-carte');

  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  maplibregl.removeProtocol?.('pmtiles');
  maplibregl.addProtocol('pmtiles', protocol.tile);

  const [w, s, e, n] = lot.zone.bbox;
  const map = new maplibregl.Map({
    container: 'carte',
    style: baseStyle(lot, pmtilesNames),
    bounds: [[w, s], [e, n]],
    fitBoundsOptions: { padding: 24 },
    maxBounds: [[w - 3, s - 3], [e + 3, n + 3]],
    maxZoom: 18,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  mapInstance = map;
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: lot.attributions }));
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true, timeout: 60000, maximumAge: 15000 },
    trackUserLocation: true,
    showAccuracyCircle: true,
    fitBoundsOptions: { maxZoom: 14 },
  });
  map.addControl(geolocate, 'top-right');
  geolocate.on('error', (event) => {
    locating = false;
    if (event.code === 1) openPanel(locationDenied);
    else notify('Position pas encore trouvée : rester à découvert une ou deux minutes, puis réessayer.');
  });
  geolocate.on('outofmaxbounds', () => notify('Vous êtes hors de la carte enregistrée.'));
  geolocate.on('trackuserlocationstart', () => { locating = true; });
  geolocate.on('trackuserlocationend', () => { locating = false; });
  geolocate.on('geolocate', (event) => { setPosition(event.coords); });

  map.on('load', async () => {
    const attribution = document.querySelector('.maplibregl-ctrl-attrib');
    if (attribution) {
      attribution.classList.remove('maplibregl-compact-show');
      attribution.removeAttribute('open');
    }
    addDataLayers(map, lot);
    await refreshPersoLayer();
    map.on('click', onMapClick);
  });
}

function locationDenied() {
  return [el('h2', {}, 'Position refusée'),
    el('p', {}, 'L’iPhone n’autorise pas Gold Terrain à connaître la position. Pour l’autoriser :'),
    el('ol', { className: 'etapes' },
      el('li', {}, 'Ouvrir Réglages › Confidentialité et sécurité › Service de localisation.'),
      el('li', {}, 'Choisir « Sites web Safari », puis « Lorsque l’app est active », et activer « Position exacte ».'),
      el('li', {}, 'Revenir dans Gold Terrain et appuyer de nouveau sur « Me localiser ».')),
    el('p', { className: 'petit' }, 'En secours, les mêmes points sont dans Organic Maps (paquet de fichiers).')];
}

// --- Écrans et déroulé --------------------------------------------------------------------------

function isStandalone() {
  const dev = ['localhost', '127.0.0.1'].includes(location.hostname)
    && new URLSearchParams(location.search).has('dev');
  return dev || navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

function errorText(err) {
  return err instanceof UserError ? err.message : `Erreur : ${(err && err.message) || err}`;
}

function firstDownload(kek, version) {
  return withLock(async () => {
    waiting('Téléchargement de la zone…', 0);
    const target = version || await fetchVersion();
    const pointer = await installVersion(target, kek, (p) => waiting('Téléchargement de la zone…', p));
    try { await navigator.storage?.persist?.(); } catch (err) { /* sans effet sur certains appareils */ }
    await renderMap(pointer);
    notify('Prêt pour le mode avion.');
  });
}

function showPhrase(message) {
  show('ecran-phrase');
  $('phrase-message').textContent = message || '';
  $('phrase-retour').hidden = !currentLot;
}

async function onPhraseSubmit(event) {
  event.preventDefault();
  const phrase = $('phrase').value;
  const message = $('phrase-message');
  message.textContent = '';
  if (normalizeSecret(phrase).length < 16) {
    message.textContent = 'La phrase compte 16 lettres et chiffres.';
    return;
  }
  const submit = event.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const version = await fetchVersion();
    const raw = await deriveKekBits(phrase, version.kdf);
    const kek = await importKek(raw);
    try {
      await unwrapDataKey(version.key, kek);
    } catch (err) {
      throw new UserError('Phrase incorrecte. Vérifier les lettres et recommencer.');
    }
    await storeKek(raw, kek);
    await dbSet('sel', version.kdf.salt);
    await dbSet('nouvelle_phrase', false);
    $('phrase').value = '';
    await firstDownload(kek, version);
  } catch (err) {
    showPhrase(errorText(err));
  } finally {
    submit.disabled = false;
  }
}

function isNewer(version, pointer) {
  return !pointer || String(version.version) > String(pointer.version);
}

function checkForUpdate(manual, status) {
  if (!manual && !navigator.onLine) return Promise.resolve();
  return withLock(async () => {
    const say = (text) => { if (manual && status) status.textContent = text; };
    try {
      const kek = await loadKek();
      if (!kek) return;
      const version = await fetchVersion();
      if (version.kdf.salt !== await dbGet('sel')) {
        await dbSet('nouvelle_phrase', true);
        notify('Une nouvelle phrase secrète a été publiée.', { label: 'La saisir', run: () => showPhrase() });
        say('Nouvelle phrase secrète nécessaire pour mettre à jour.');
        return;
      }
      const pointer = await dbGet('courant');
      if (!isNewer(version, pointer)) {
        say('Déjà à jour.');
        return;
      }
      say('Téléchargement…');
      const installed = await installVersion(version, kek);
      notify(`Mise à jour reçue : titres au ${formatDate(installed.tenement_snapshot_date)}.`, {
        label: 'Afficher', run: () => location.reload() });
      say('Mise à jour reçue.');
    } catch (err) {
      say(errorText(err));
    }
  });
}

async function openState() {
  const rows = [];
  const add = (label, value) => rows.push(el('dt', {}, label), el('dd', {}, value));
  add('Zone', currentLot?.zone?.label || '—');
  add('Relevé des titres miniers', formatDate(currentLot?.tenement_snapshot?.date));
  add('Données publiées le', currentVersion?.published_at ? new Date(currentVersion.published_at).toLocaleString('fr-FR') : '—');
  add('Points Gold', String(currentLot?.counts?.total_points ?? '—'));
  add('Fiches', String(currentLot?.counts?.sections ?? '—'));
  add('Mes points', String((await dbAll('perso')).length));
  let persisted = 'inconnu';
  try {
    if (navigator.storage?.persisted) persisted = (await navigator.storage.persisted()) ? 'oui' : 'non (iOS peut effacer les données si l’appli reste longtemps fermée)';
  } catch (err) { /* ignoré */ }
  add('Données protégées par le téléphone', persisted);
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.usage) add('Espace utilisé', `${(estimate.usage / 1048576).toFixed(1)} Mo`);
  } catch (err) { /* ignoré */ }
  try {
    const stored = await dbGet('cle');
    add('Clé gardée', stored instanceof CryptoKey ? 'clé protégée' : 'octets (repli)');
    if (await dbGet('nouvelle_phrase')) add('Phrase secrète', 'une nouvelle phrase est à saisir');
  } catch (err) { /* ignoré */ }
  add('Réseau', navigator.onLine ? 'disponible' : 'aucun (mode avion ?)');
  const status = el('p', { className: 'message', role: 'status' });
  openPanel(() => [el('h2', {}, 'État de l’application'), el('dl', {}, rows),
    button('Mettre à jour maintenant', () => checkForUpdate(true, status), 'bouton-principal'), status,
    el('p', { className: 'petit' }, (currentLot?.attributions || []).join(' · '))]);
}

function onLocateTap() {
  if (!geolocate) return;
  if (locating) {
    if (lastPosition) mapInstance.easeTo({ center: lastPosition });
    else notify('Recherche de la position en cours : rester à découvert une ou deux minutes.');
    return;
  }
  if (!geolocate.trigger()) notify('Carte pas encore prête, réessayer dans un instant.');
}

async function start() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* l'appli marche sans, mais pas hors ligne */ });
  }
  $('panneau-fermer').addEventListener('click', () => { stopGuide(); closePanel(); });
  $('panneau-retour').addEventListener('click', backPanel);
  $('form-phrase').addEventListener('submit', onPhraseSubmit);
  $('phrase-retour').addEventListener('click', () => show('ecran-carte'));
  $('bouton-etat').addEventListener('click', openState);
  $('bouton-dossier').addEventListener('click', openDossier);
  $('bouton-couches').addEventListener('click', openLayers);
  $('bouton-position').addEventListener('click', onLocateTap);
  $('bouton-point').addEventListener('click', startPlacing);
  $('bouton-trace').addEventListener('click', toggleTrace);
  $('bouton-vehicule').addEventListener('click', openVehicle);
  $('bouton-journal').addEventListener('click', openJournal);
  $('pose-annuler').addEventListener('click', stopPlacing);
  $('pose-ici').addEventListener('click', () => {
    const c = mapInstance.getCenter();
    stopPlacing();
    editPersoPoint(null, [c.lng, c.lat]);
  });
  $('pose-position').addEventListener('click', async () => {
    try {
      const position = await currentPositionOnce();
      stopPlacing();
      editPersoPoint(null, position);
    } catch (err) {
      notify(err.message);
    }
  });
  $('frise-annee').addEventListener('input', () => showFrise(true));
  $('attente-reessayer').addEventListener('click', () => location.reload());

  if (!isStandalone()) {
    const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
    $('autre-appareil').hidden = iphone;
    show('ecran-installation');
    return;
  }

  let kek = null;
  let pointer = null;
  try {
    kek = await loadKek();
    pointer = await dbGet('courant');
  } catch (err) {
    waitingError('Stockage du téléphone indisponible. Fermer l’appli et la rouvrir.');
    return;
  }
  if (!kek) {
    showPhrase();
    return;
  }
  if (!pointer) {
    try {
      await firstDownload(kek);
    } catch (err) {
      waitingError(errorText(err));
    }
  } else {
    try {
      await renderMap(pointer);
      withLock(() => deleteDataExcept(pointer.prefix)).catch(() => {});
    } catch (err) {
      if (!(err instanceof MissingData) && !(err instanceof UserError)) {
        waitingError(errorText(err));
        return;
      }
      // Données effacées par iOS, ou d'un format plus ancien que l'appli : on retélécharge. Le pointeur
      // n'est effacé que si les données ont vraiment disparu ; sinon il reste pour un nouvel essai.
      if (err instanceof MissingData) await dbSet('courant', null);
      try {
        await firstDownload(kek);
      } catch (inner) {
        waitingError(err instanceof MissingData
          ? 'Les données de la carte ont été effacées par le téléphone. Se connecter au Wi-Fi puis réessayer.'
          : errorText(inner));
        return;
      }
    }
  }
  if (await dbGet('nouvelle_phrase')) {
    notify('Une nouvelle phrase secrète a été publiée.', { label: 'La saisir', run: () => showPhrase() });
  }
  updateBadge();
  window.addEventListener('online', () => checkForUpdate(false));
  checkForUpdate(false);
}

start();
