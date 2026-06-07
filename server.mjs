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

import { createServer }            from 'node:http'
import { readFile }                from 'node:fs/promises'
import { join, extname }           from 'node:path'
import { fileURLToPath }           from 'node:url'
import { execFileSync }            from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir }                  from 'node:os'

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

// GET /api/sleep  →  last 14 days sleep score + stages, decoded from .hae
const SLEEP_DIR = `${process.env.HOME}/Library/Mobile Documents/iCloud~com~ifunography~HealthExport/Documents/AutoSync/HealthMetrics/sleep_analysis`
const APPLE_EPOCH_MS = new Date('2001-01-01T00:00:00Z').getTime()
let sleepCache = null   // { ts: Date, data: [...] }
const SLEEP_CACHE_TTL = 5 * 60 * 1000  // re-decode every 5 min

function decodeHae(filePath) {
  const tmp = join(mkdtempSync(join(tmpdir(), 'hae-')), 'out.json')
  try {
    execFileSync('compression_tool', ['-decode', '-a', 'lzfse', '-i', filePath, '-o', tmp],
      { stdio: 'ignore', timeout: 5000 })
    const raw = JSON.parse(execFileSync('cat', [tmp], { encoding: 'utf8' }))
    return raw.data ?? []
  } catch { return [] }
  finally { try { rmSync(join(tmp, '..'), { recursive: true }) } catch {} }
}

function sleepScore(hrs) {
  if (hrs === null || hrs < 2 || hrs > 13) return null
  if (hrs >= 7 && hrs <= 9)  return Math.min(100, Math.round(85 + (hrs - 7) / 2 * 15))
  if (hrs >= 6 && hrs < 7)   return Math.round(70 + (hrs - 6) * 15)
  if (hrs >= 5 && hrs < 6)   return Math.round(55 + (hrs - 5) * 15)
  if (hrs >= 4 && hrs < 5)   return Math.round(40 + (hrs - 4) * 15)
  if (hrs >= 2 && hrs < 4)   return Math.round(20 + (hrs - 2) * 10)
  if (hrs > 9 && hrs <= 13)  return Math.max(60, Math.round(85 - (hrs - 9) * 6))
  return null
}

function buildSleepData() {
  // Collect all samples (dedup by start timestamp)
  let files = []
  try { files = readdirSync(SLEEP_DIR).filter(f => f.endsWith('.hae')).sort() } catch { return [] }

  const seen = new Set()
  const allSamples = []
  for (const f of files) {
    for (const s of decodeHae(join(SLEEP_DIR, f))) {
      const key = `${s.start}-${s.end}`
      if (!seen.has(key)) { seen.add(key); allSamples.push(s) }
    }
  }

  // Group by wake-up date in CST (UTC+8)
  const byDate = {}
  for (const s of allSamples) {
    const ts = s.end ?? s.start
    if (!ts) continue
    const wakeMs = APPLE_EPOCH_MS + ts * 1000
    const cstDate = new Date(wakeMs + 8 * 3600 * 1000).toISOString().slice(0, 10)
    if (!byDate[cstDate]) byDate[cstDate] = { total: 0, deep: 0, rem: 0, core: 0, awake: 0 }
    const d = byDate[cstDate]
    d.total += s.totalSleep ?? 0
    d.deep  += s.deep   ?? 0
    d.rem   += s.rem    ?? 0
    d.core  += s.core   ?? 0
    d.awake += s.awake  ?? 0
  }

  // Build last 14 days
  const days = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    const entry = byDate[key]
    const hrs = entry ? Math.round(entry.total * 10) / 10 : null
    const score = sleepScore(hrs)
    days.push({
      date: `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`,
      hrs,
      score,
      stages: entry ? {
        deep:  Math.round(entry.deep  * 10) / 10,
        rem:   Math.round(entry.rem   * 10) / 10,
        core:  Math.round(entry.core  * 10) / 10,
        awake: Math.round(entry.awake * 10) / 10,
      } : null,
    })
  }

  const latest = [...days].reverse().find(d => d.score !== null) ?? null
  return { days, latest }
}

async function apiSleep(res) {
  const now = Date.now()
  if (!sleepCache || now - sleepCache.ts > SLEEP_CACHE_TTL) {
    sleepCache = { ts: now, data: buildSleepData() }
  }
  json(res, 200, sleepCache.data)
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
    if (path === '/api/sleep'  && method === 'GET')  return apiSleep(res)
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
