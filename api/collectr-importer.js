import { runCollectrImport } from '../scripts/collectr-importer-core.mjs'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const SUPABASE_AUTH_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY
const SUPABASE_IMPORT_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY

const IMPORT_RATE_LIMIT = (() => {
  const raw = Number(process.env.COLLECTR_IMPORT_RATE_LIMIT)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10
})()

const IMPORT_RATE_WINDOW_MS = (() => {
  const raw = Number(process.env.COLLECTR_IMPORT_RATE_WINDOW_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 86_400_000
})()
const IMPORT_RATE_STATE_MAX_ENTRIES = (() => {
  const raw = Number(process.env.COLLECTR_IMPORT_RATE_STATE_MAX_ENTRIES)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50_000
})()
const IMPORT_RATE_STATE_PRUNE_INTERVAL_MS = (() => {
  const raw = Number(process.env.COLLECTR_IMPORT_RATE_STATE_PRUNE_INTERVAL_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000
})()

const importRateState = new Map()
let lastImportRatePruneAt = 0

const extractToken = (req) => {
  const header = req.headers?.authorization || ''
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim()
  }
  return null
}

const getClientIp = (req) => {
  return (
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  )
}

const pruneImportRateState = (now) => {
  if (
    now - lastImportRatePruneAt < IMPORT_RATE_STATE_PRUNE_INTERVAL_MS &&
    importRateState.size <= IMPORT_RATE_STATE_MAX_ENTRIES
  ) {
    return
  }

  for (const [key, entry] of importRateState.entries()) {
    if (!entry || entry.resetAt <= now) {
      importRateState.delete(key)
    }
  }

  if (importRateState.size > IMPORT_RATE_STATE_MAX_ENTRIES) {
    const overflow = importRateState.size - IMPORT_RATE_STATE_MAX_ENTRIES
    const oldest = [...importRateState.entries()].sort(
      (left, right) => (left[1]?.resetAt || 0) - (right[1]?.resetAt || 0),
    )
    for (let index = 0; index < overflow; index += 1) {
      importRateState.delete(oldest[index][0])
    }
  }

  lastImportRatePruneAt = now
}

const applyRateLimit = (key) => {
  const now = Date.now()
  pruneImportRateState(now)
  let entry = importRateState.get(key)
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + IMPORT_RATE_WINDOW_MS }
  }
  entry.count += 1
  importRateState.set(key, entry)

  return {
    limit: IMPORT_RATE_LIMIT,
    remaining: Math.max(0, IMPORT_RATE_LIMIT - entry.count),
    resetAt: entry.resetAt,
    exceeded: entry.count > IMPORT_RATE_LIMIT,
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!SUPABASE_URL || !SUPABASE_AUTH_KEY || !SUPABASE_IMPORT_KEY) {
    res.status(500).json({ error: 'Supabase env vars are missing.' })
    return
  }

  const token = extractToken(req)
  if (!token) {
    res.status(401).json({ error: 'Missing authorization token.' })
    return
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_AUTH_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: authData, error: authError } = await authClient.auth.getUser(token)
  if (authError || !authData?.user?.id) {
    res.status(401).json({ error: 'Invalid or expired session.' })
    return
  }

  const rateKey = `${authData.user.id}:${getClientIp(req)}`
  const rate = applyRateLimit(rateKey)
  res.setHeader('X-RateLimit-Limit', String(rate.limit))
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining))
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(rate.resetAt / 1000)))
  if (rate.exceeded) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))))
    res.status(429).json({ error: 'Rate limit exceeded. Please try again shortly.' })
    return
  }

  const urlParam = Array.isArray(req.query?.url) ? req.query.url[0] : req.query?.url
  if (!urlParam) {
    res.status(400).json({ error: 'Missing Collectr URL.' })
    return
  }

  const formatError = (err) => {
    if (err === null || err === undefined) return 'Unknown error'
    if (typeof err === 'string') return err
    if (typeof err === 'object') {
      const maybeCause = err.cause
      if (maybeCause) {
        if (typeof maybeCause === 'string') return maybeCause
        if (typeof maybeCause === 'object') {
          const causeMessage = maybeCause.message
          const causeCode = maybeCause.code
          if (typeof causeMessage === 'string' && causeMessage.trim().length > 0) {
            return causeCode ? `${causeMessage} (${String(causeCode)})` : causeMessage
          }
          if (typeof causeCode === 'string' || typeof causeCode === 'number') {
            return `Request failed (${String(causeCode)})`
          }
        }
      }
      if (err instanceof Error && err.message) return err.message
      const maybeMessage = err.message
      if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) {
        return maybeMessage
      }
      const maybeError = err.error
      if (typeof maybeError === 'string' && maybeError.trim().length > 0) {
        return maybeError
      }
      try {
        return JSON.stringify(err, Object.getOwnPropertyNames(err))
      } catch {
        return String(err)
      }
    }
    return String(err)
  }

  try {
    const sanitizedUrl = String(urlParam || '').trim().replace(/\\+$/, '')
    const payload = await runCollectrImport({
      url: sanitizedUrl,
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_IMPORT_KEY,
    })

    res.status(200).json(payload)
  } catch (err) {
    const message = formatError(err)
    const isBadRequest =
      /invalid collectr url|missing collectr url|app.getcollectr.com/i.test(message)
    res.status(isBadRequest ? 400 : 500).json({ error: message })
  }
}
