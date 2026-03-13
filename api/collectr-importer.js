import { runCollectrImport } from '../scripts/collectr-importer-core.mjs'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const SUPABASE_AUTH_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY
const SUPABASE_IMPORT_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY
const CONSUME_IMPORT_QUOTA_RPC = 'consume_collectr_import_quota'

const IMPORT_RATE_LIMIT = (() => {
  const raw = Number(process.env.COLLECTR_IMPORT_RATE_LIMIT)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10
})()

const extractToken = (req) => {
  const header = req.headers?.authorization || ''
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim()
  }
  return null
}

const getSupabaseClient = (apiKey) => {
  return createClient(SUPABASE_URL, apiKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

const toPositiveInt = (value) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  const int = Math.floor(num)
  return int > 0 ? int : null
}

const getDefaultResetAtMs = () => {
  const now = new Date()
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  )
}

const parseResetAtMs = (value) => {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  return getDefaultResetAtMs()
}

const consumeImportQuota = async (rateClient, userId) => {
  const { data, error } = await rateClient.rpc(CONSUME_IMPORT_QUOTA_RPC, {
    p_user_id: userId,
    p_limit: IMPORT_RATE_LIMIT,
  })
  if (error) throw error

  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') {
    throw new Error('Rate limit service returned an invalid response.')
  }

  const limit = toPositiveInt(row.limit_count) || IMPORT_RATE_LIMIT
  const usedCount = Math.max(0, Number(row.used_count) || 0)
  const remainingRaw = Number(row.remaining)
  const remaining = Number.isFinite(remainingRaw)
    ? Math.max(0, Math.floor(remainingRaw))
    : Math.max(0, limit - usedCount)
  const resetAtMs = parseResetAtMs(row.reset_at)
  const allowed = row.allowed === true || usedCount <= limit

  return {
    limit,
    remaining,
    usedCount,
    resetAtMs,
    allowed,
  }
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is required for importer rate limiting.' })
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

  const authClient = getSupabaseClient(SUPABASE_AUTH_KEY)
  const rateClient = getSupabaseClient(SUPABASE_SERVICE_ROLE_KEY)

  const { data: authData, error: authError } = await authClient.auth.getUser(token)
  if (authError || !authData?.user?.id) {
    res.status(401).json({ error: 'Invalid or expired session.' })
    return
  }

  let rate
  try {
    rate = await consumeImportQuota(rateClient, authData.user.id)
  } catch (rateError) {
    res.status(503).json({ error: formatError(rateError) || 'Rate limit service unavailable.' })
    return
  }

  res.setHeader('X-RateLimit-Limit', String(rate.limit))
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining))
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(rate.resetAtMs / 1000)))
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rate.resetAtMs - Date.now()) / 1000))))
    res.status(429).json({ error: 'Rate limit exceeded. Please try again shortly.' })
    return
  }

  const urlParam = Array.isArray(req.query?.url) ? req.query.url[0] : req.query?.url
  if (!urlParam) {
    res.status(400).json({ error: 'Missing Collectr URL.' })
    return
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
