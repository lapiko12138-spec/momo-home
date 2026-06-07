/**
 * momo-home local server
 * ─────────────────────────────────────────────────────────────
 * Serves the static home page + provides a small /api layer so
 * the pet and other local tools can call this hub.
 *
 * Port: 3002  (change PORT below or set env PORT=xxxx)
 *
 * Endpoints
 * ──────────
 *   GET  /                  → index.html
 *   GET  /bow-kitty.webp    → sprite atlas
 *   GET  /state-map.json    → pet state map
 *   GET  /api/scores        → proxy → localhost:4100/scores/today
 *   POST /api/chat          → proxy → localhost:8642/v1/chat/completions
 *   GET  /api/health        → {"ok":true,"services":{...}} (liveness)
 */

import { createServer } from 'node:http'
import { readFile }      from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = fileURLToPath(new URL('.', import.meta.url))
const PORT  = Number(process.env.PORT ?? 3002)

const MOCK_URL   = 'http://localhost:4100'
const HERMES_URL = 'http://localhost:8642'

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.css' : 'text/css',
  '.js'  : 'text/javascript',
  '.png' : 'image/png',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon',
}

// ── helpers ───────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
}

function json(res, status, body) {
  cors(res)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end',  () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

async function proxyFetch(url, opts = {}) {
  const res  = await fetch(url, { signal: AbortSignal.timeout(8000), ...opts })
  const text = await res.text()
  return { status: res.status, ok: res.ok, text,
    json: () => JSON.parse(text) }
}

// ── static file handler ───────────────────────────────────────────────────────
async function serveStatic(req, res) {
  const safePath = req.url.split('?')[0].replace(/\.\./g, '')
  const filePath = join(__dir, safePath === '/' ? 'index.html' : safePath)
  try {
    const data = await readFile(filePath)
    const ext  = extname(filePath)
    cors(res)
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}

// ── API routes ────────────────────────────────────────────────────────────────

// GET /api/scores  →  proxy :4100/scores/today
async function apiScores(res) {
  try {
    const r = await proxyFetch(`${MOCK_URL}/scores/today`)
    json(res, r.status, r.json())
  } catch (e) {
    json(res, 502, { error: 'mock server offline', detail: e.message })
  }
}

// POST /api/chat  →  proxy :8642/v1/chat/completions
async function apiChat(req, res) {
  try {
    const body = await readBody(req)
    const r = await proxyFetch(`${HERMES_URL}/v1/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': req.headers['authorization'] ?? '',
      },
      body,
    })
    json(res, r.status, r.json())
  } catch (e) {
    json(res, 502, { error: 'hermes offline', detail: e.message })
  }
}

// GET /api/health  →  aggregate liveness of local services
async function apiHealth(res) {
  const check = async (url) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) })
      return r.ok
    } catch { return false }
  }
  const [mock, hermes, health, calendar, wardrobe, weread] = await Promise.all([
    check(`${MOCK_URL}/scores/today`),
    check(`${HERMES_URL}/v1/models`),
    check('http://localhost:4173/'),
    check('http://localhost:3456/todo-calendar.html'),
    check('http://localhost:3001/web/'),
    check('http://localhost:8788/'),
  ])
  json(res, 200, {
    ok: true,
    services: { mock, hermes, health, calendar, wardrobe, weread },
  })
}

// ── main ──────────────────────────────────────────────────────────────────────
createServer(async (req, res) => {
  const { method, url } = req

  // preflight
  if (method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return }

  if (url.startsWith('/api/')) {
    const path = url.split('?')[0]
    if (path === '/api/scores' && method === 'GET')  return apiScores(res)
    if (path === '/api/chat'   && method === 'POST') return apiChat(req, res)
    if (path === '/api/health' && method === 'GET')  return apiHealth(res)
    json(res, 404, { error: 'unknown api route' })
    return
  }

  return serveStatic(req, res)

}).listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   momo-home  →  http://localhost:${PORT}/  ║
╠══════════════════════════════════════════╣
║  /api/scores   proxy → :4100            ║
║  /api/chat     proxy → :8642            ║
║  /api/health   services liveness        ║
╚══════════════════════════════════════════╝
`)
})
