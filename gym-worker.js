/**
 * Home Gym — sync Worker (Cloudflare Workers + KV)
 * ------------------------------------------------
 * Required bindings, set in the Worker's Settings:
 *   KV namespace binding   name: GYM        -> your "gym-data" namespace
 *   Secret / Variable      name: GYM_PIN    -> your household PIN, e.g. 4821
 * Optional variable:
 *   ALLOW_ORIGIN           comma-separated list of allowed site origins
 *
 * Endpoints:
 *   GET  /health  -> {ok:true}
 *   POST /sync    -> body = full client state; returns the merged state
 */

const DEFAULT_ORIGINS =
  'https://runelord1999.github.io,http://localhost:8000,http://127.0.0.1:8000';
const KEY = 'data';
const MAX_BODY = 4 * 1024 * 1024;   // 4 MB
const MAX_TOMBSTONES = 5000;
const EMPTY = () => ({ profiles: [], logs: [], measurements: [], deleted: [] });

export default {
  async fetch(request, env) {
    const allowed = String(env.ALLOW_ORIGIN || DEFAULT_ORIGINS)
      .split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const headers = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Gym-Pin',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
      'Cache-Control': 'no-store',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

    if (path === '/health') {
      return json({ ok: true, configured: !!(env.GYM && env.GYM_PIN), time: Date.now() }, 200, headers);
    }
    if (path !== '/sync') return json({ error: 'not_found' }, 404, headers);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, headers);

    if (!env.GYM || !env.GYM_PIN) return json({ error: 'server_not_configured' }, 500, headers);
    if ((request.headers.get('X-Gym-Pin') || '') !== String(env.GYM_PIN)) {
      return json({ error: 'bad_pin' }, 401, headers);
    }

    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'too_large' }, 413, headers);

    let incoming;
    try { incoming = JSON.parse(text); } catch (e) { return json({ error: 'bad_json' }, 400, headers); }

    const stored = await read(env);
    const merged = merge(stored, clean(incoming));
    await env.GYM.put(KEY, JSON.stringify(merged));
    return json({ ok: true, data: merged, serverTime: Date.now() }, 200, headers);
  },
};

/* ---------- helpers ---------- */

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function read(env) {
  try {
    const raw = await env.GYM.get(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const c = clean(parsed);
      c.rev = num(parsed.rev) || 0;
      return c;
    }
  } catch (e) { /* corrupt value -> start fresh rather than 500 */ }
  return EMPTY();
}

const arr = v => (Array.isArray(v) ? v.slice(0, 20000) : []);
const num = v => (v === null || v === '' || v === undefined || !Number.isFinite(+v) ? null : +v);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Validate and coerce anything a client sends. Never trust the body. */
function clean(d) {
  const out = EMPTY();
  if (!d || typeof d !== 'object') return out;

  for (const p of arr(d.profiles)) {
    const id = str(p && p.id, 64);
    if (!id) continue;
    out.profiles.push({
      id,
      name: str(p.name, 24) || '?',
      sex: p.sex === 'F' ? 'F' : 'M',
      dob: /^\d{4}-\d{2}-\d{2}$/.test(p.dob) ? p.dob : '',
      color: /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : '#c6ff3d',
      createdAt: num(p.createdAt) || Date.now(),
      updatedAt: num(p.updatedAt) || num(p.createdAt) || 0,
    });
  }
  for (const l of arr(d.logs)) {
    const id = str(l && l.id, 64), pid = str(l && l.pid, 64), ex = str(l && l.ex, 32);
    const val = num(l && l.val), ts = num(l && l.ts);
    if (!id || !pid || !ex || val === null || ts === null) continue;
    out.logs.push({ id, pid, ex, val: Math.max(1, Math.min(Math.round(val), 100000)), ts });
  }
  for (const m of arr(d.measurements)) {
    const id = str(m && m.id, 64), pid = str(m && m.pid, 64), ts = num(m && m.ts);
    if (!id || !pid || ts === null) continue;
    out.measurements.push({ id, pid, ts, h: num(m.h), w: num(m.w) });
  }
  for (const t of arr(d.deleted)) {
    const id = typeof t === 'string' ? t.slice(0, 64) : str(t && t.id, 64);
    if (id) out.deleted.push({ id, at: num(t && t.at) || Date.now() });
  }
  return out;
}

/**
 * Union by id. Profiles resolve by updatedAt (last edit wins); logs and
 * measurements are immutable so either copy will do. Tombstones win over both,
 * and records belonging to a deleted profile are dropped.
 */
function merge(a, b) {
  const deleted = new Map();
  for (const t of [...a.deleted, ...b.deleted]) {
    const prev = deleted.get(t.id);
    if (!prev || t.at > prev.at) deleted.set(t.id, t);
  }

  const union = (base, extra, chooser) => {
    const m = new Map();
    for (const r of base) m.set(r.id, r);
    for (const r of extra) m.set(r.id, m.has(r.id) && chooser ? chooser(m.get(r.id), r) : r);
    return [...m.values()].filter(r => !deleted.has(r.id));
  };
  const newer = (x, y) => ((y.updatedAt || 0) >= (x.updatedAt || 0) ? y : x);

  const profiles = union(a.profiles, b.profiles, newer);
  const live = new Set(profiles.map(p => p.id));

  return {
    profiles,
    logs: union(a.logs, b.logs).filter(l => live.has(l.pid)),
    measurements: union(a.measurements, b.measurements).filter(m => live.has(m.pid)),
    deleted: [...deleted.values()].sort((x, y) => y.at - x.at).slice(0, MAX_TOMBSTONES),
    rev: (num(a.rev) || 0) + 1,
    updatedAt: Date.now(),
  };
}
