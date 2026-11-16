#!/usr/bin/env node
// Fetches the public POTA park list for every state in config.json, merges and
// dedupes by park reference, and writes static JSON into /data.
//
//   node scripts/update-data.mjs
//
// No dependencies (Node 18+), no API keys, no login. One request per state,
// spaced out by config.api.delayMs. If any state fails, nothing is written, so
// a bad night never replaces good data with partial data.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const { parksByLocation, userAgent, delayMs = 2000 } = config.api;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchState(code) {
  const url = parksByLocation.replace('{code}', encodeURIComponent(code));
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const parks = await res.json();
      if (!Array.isArray(parks) || parks.length === 0) {
        throw new Error('response was empty or not a list');
      }
      if (!parks[0].reference || !('activations' in parks[0])) {
        throw new Error('response does not look like a park list (fields changed?)');
      }
      return parks;
    } catch (err) {
      lastError = err;
      console.warn(`  ${code}: attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) await sleep(delayMs * attempt * 2);
    }
  }
  throw new Error(`${code}: giving up after 3 attempts (${lastError.message})`);
}

const clean = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

const byRef = new Map();
const perState = {};

for (const [i, state] of config.states.entries()) {
  if (i > 0) await sleep(delayMs);
  const parks = await fetchState(state.code);
  perState[state.code] = parks.length;
  console.log(`  ${state.code}: ${parks.length} parks`);
  for (const p of parks) {
    if (byRef.has(p.reference)) continue; // multi-state park already seen
    const lat = Number(p.latitude);
    const lon = Number(p.longitude);
    byRef.set(p.reference, {
      reference: p.reference,
      name: clean(p.name),
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lon) ? lon : null,
      grid: clean(p.grid),
      // Comma separated list of every state the park is in, e.g. "US-NE,US-SD"
      locationDesc: clean(p.locationDesc).replace(/\s*,\s*/g, ','),
      attempts: num(p.attempts),
      activations: num(p.activations),
      qsos: num(p.qsos),
      website: clean(p.website),
      notes: clean(p.notes),
    });
  }
}

const parks = [...byRef.values()].sort((a, b) =>
  a.reference.localeCompare(b.reference, 'en', { numeric: true })
);
const parksJson = JSON.stringify(parks, null, 0).replace(/\},\{/g, '},\n{') + '\n';

await mkdir(dataDir, { recursive: true });
const parksFile = path.join(dataDir, 'parks.json');
const metaFile = path.join(dataDir, 'meta.json');

let previous = null;
try {
  previous = await readFile(parksFile, 'utf8');
} catch {}

if (previous === parksJson) {
  console.log(`No changes (${parks.length} parks). Files left untouched.`);
} else {
  const meta = {
    generatedAt: new Date().toISOString(),
    source: parksByLocation,
    states: config.states.map((s) => s.code),
    parksPerState: perState,
    totalParks: parks.length,
  };
  await writeFile(parksFile, parksJson);
  await writeFile(metaFile, JSON.stringify(meta, null, 2) + '\n');
  console.log(`Wrote ${parks.length} unique parks to data/parks.json (${meta.generatedAt}).`);
}
