/* Gold Terrain — service worker : garde la coquille de l'appli pour le mode avion.
   Les données (fichiers .enc et version.json) ne passent jamais par ce cache : l'appli les range
   elle-même, déchiffrées, dans le cache « gold-terrain-donnees ». */
'use strict';

const SHELL_PREFIX = 'gold-terrain-coquille-';
const SHELL = SHELL_PREFIX + 'fbd3c3b62a2a93a7';
const FILES = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.webmanifest',
  './vendor/maplibre-gl.js',
  './vendor/maplibre-gl.css',
  './vendor/pmtiles.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(FILES.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(SHELL_PREFIX) && key !== SHELL)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/version.json') || url.pathname.endsWith('.enc')) return;
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(SHELL)
        .then((cache) => cache.match('./index.html'))
        .then((cached) => cached || fetch(request)));
    return;
  }
  event.respondWith(
    caches.open(SHELL)
      .then((cache) => cache.match(request, { ignoreSearch: true }))
      .then((cached) => cached || fetch(request)));
});
