import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const SUPABASE_AUTH_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY
const ADMIN_USER_IDS = new Set(
  String(process.env.ADMIN_USER_IDS || process.env.ADMIN_USER_ID || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
)
const CARDHQ_ISSUER_URL = String(process.env.CARDHQ_ISSUER_URL || '')
  .trim()
  .replace(/\/+$/, '')
const CARDHQ_ISSUER_SECRET = String(process.env.CARDHQ_ISSUER_SECRET || '').trim()
const CARDHQ_ISSUER_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CARDHQ_ISSUER_TIMEOUT_MS)
  if (Number.isFinite(raw) && raw > 0) return raw
  return 10000
})()

const DEFAULT_RATE_LIMIT = 120
const REQUEST_COLUMNS =
  'request_id, user_id, email, reason, status, source_ip, user_agent, created_at, reviewed_at, reviewed_by, admin_notes, api_key_id, api_key_preview'

const extractToken = (req) => {
  const header = req.headers?.authorization || ''
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim()
  }
  return null
}

const getJsonBody = (req) => {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string' && req.body.trim().length > 0) {
    return JSON.parse(req.body)
  }
  return {}
}

const getErrorMessage = (err, fallback) => {
  if (!err) return fallback
  if (typeof err === 'string') return err
  if (typeof err === 'object') {
    if (typeof err.message === 'string' && err.message.trim().length > 0) return err.message
    if (typeof err.error === 'string' && err.error.trim().length > 0) return err.error
  }
  return fallback
}

const toInt = (value) => {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const sanitizePrefix = (value) => {
  const raw = String(value || 'chq').trim().toLowerCase()
  const safe = raw.replace(/[^a-z0-9_-]/g, '')
  if (safe.length < 2) return 'chq'
  return safe.slice(0, 20)
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)

const makeIssuerRequest = async (path, payload) => {
  if (!CARDHQ_ISSUER_URL || !CARDHQ_ISSUER_SECRET) {
    throw new Error('CARDHQ_ISSUER_URL and CARDHQ_ISSUER_SECRET are required.')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CARDHQ_ISSUER_TIMEOUT_MS)

  try {
    const response = await fetch(`${CARDHQ_ISSUER_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-secret': CARDHQ_ISSUER_SECRET,
      },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    })

    const responseBody = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(
        getErrorMessage(responseBody, `CardHQ issuer request failed (${response.status}).`),
      )
    }
    return responseBody
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('CardHQ issuer request timed out.')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

const issueCardhqKey = async (payload) => {
  const body = await makeIssuerRequest('/admin/api-keys/issue', payload)
  const apiKeyId = String(body?.apiKeyId || '').trim()
  const apiKey = String(body?.apiKey || '').trim()
  const apiKeyPreview = String(body?.apiKeyPreview || '').trim() || null

  if (!apiKeyId || !apiKey) {
    throw new Error('CardHQ issuer response was missing required fields.')
  }

  return {
    apiKeyId,
    apiKey,
    apiKeyPreview,
  }
}

const revokeCardhqKey = async (apiKeyId) => {
  const value = String(apiKeyId || '').trim()
  if (!value) return false
  try {
    await makeIssuerRequest('/admin/api-keys/revoke', { apiKeyId: value })
    return true
  } catch (err) {
    console.error('Failed to revoke CardHQ key:', getErrorMessage(err, 'Unknown error'))
    return false
  }
}

async function requireAdminUser(req) {
  if (!SUPABASE_URL || !SUPABASE_AUTH_KEY) {
    throw new Error('Supabase env vars are missing.')
  }
  if (ADMIN_USER_IDS.size === 0) {
    throw new Error('ADMIN_USER_IDS is not configured.')
  }

  const token = extractToken(req)
  if (!token) {
    const err = new Error('Missing authorization token.')
    err.status = 401
    throw err
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_AUTH_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await authClient.auth.getUser(token)
  if (error || !data?.user) {
    const err = new Error('Invalid or expired session.')
    err.status = 401
    throw err
  }

  if (!ADMIN_USER_IDS.has(String(data.user.id || ''))) {
    const err = new Error('Forbidden.')
    err.status = 403
    throw err
  }

  return data.user
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!SUPABASE_URL || !SUPABASE_AUTH_KEY) {
    res.status(500).json({ error: 'Supabase env vars are missing.' })
    return
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is required for admin actions.' })
    return
  }

  let adminUser
  try {
    adminUser = await requireAdminUser(req)
  } catch (err) {
    const status = Number(err?.status) || 500
    res.status(status).json({ error: getErrorMessage(err, 'Admin auth failed.') })
    return
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  if (req.method === 'GET') {
    const { data, error } = await adminClient
      .from('api_key_requests')
      .select(REQUEST_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(500)

    if (error) {
      res.status(500).json({ error: getErrorMessage(error, 'Failed to load requests.') })
      return
    }

    res.status(200).json({ ok: true, requests: data || [] })
    return
  }

  let body = {}
  try {
    body = getJsonBody(req)
  } catch {
    res.status(400).json({ error: 'Invalid JSON payload.' })
    return
  }

  const requestId = String(body?.requestId || '').trim()
  const action = String(body?.action || '').trim().toLowerCase()
  const adminNotes = String(body?.adminNotes || '').trim() || null

  if (!requestId) {
    res.status(400).json({ error: 'requestId is required.' })
    return
  }
  if (action !== 'approve' && action !== 'deny' && action !== 'regenerate') {
    res.status(400).json({ error: "action must be 'approve', 'deny', or 'regenerate'." })
    return
  }

  const { data: requestRow, error: requestError } = await adminClient
    .from('api_key_requests')
    .select(REQUEST_COLUMNS)
    .eq('request_id', requestId)
    .maybeSingle()

  if (requestError) {
    res.status(500).json({ error: getErrorMessage(requestError, 'Failed to load request.') })
    return
  }
  if (!requestRow) {
    res.status(404).json({ error: 'Request not found.' })
    return
  }
  if ((action === 'approve' || action === 'deny') && requestRow.status !== 'pending') {
    res.status(409).json({ error: `Request is already ${requestRow.status}.`, request: requestRow })
    return
  }
  if (action === 'regenerate' && requestRow.status !== 'approved') {
    res.status(409).json({
      error: `Request must be approved before regenerating a key (current: ${requestRow.status}).`,
      request: requestRow,
    })
    return
  }

  const reviewedAt = new Date().toISOString()

  if (action === 'deny') {
    const { data: deniedRow, error: denyError } = await adminClient
      .from('api_key_requests')
      .update({
        status: 'denied',
        reviewed_by: adminUser.id,
        reviewed_at: reviewedAt,
        admin_notes: adminNotes,
        api_key_id: null,
        api_key_preview: null,
      })
      .eq('request_id', requestId)
      .select(REQUEST_COLUMNS)
      .single()

    if (denyError) {
      res.status(500).json({ error: getErrorMessage(denyError, 'Failed to deny request.') })
      return
    }

    res.status(200).json({ ok: true, request: deniedRow })
    return
  }

  const keyPrefix = sanitizePrefix(body?.keyPrefix)
  const requestedRate = toInt(body?.rateLimitPerMin)
  const hasRateInput =
    hasOwn(body, 'rateLimitPerMin') &&
    body?.rateLimitPerMin !== '' &&
    body?.rateLimitPerMin !== null &&
    body?.rateLimitPerMin !== undefined
  if (hasRateInput && (!requestedRate || requestedRate <= 0)) {
    res.status(400).json({ error: 'rateLimitPerMin must be a positive number.' })
    return
  }

  const hasIsUnlimitedInput = hasOwn(body, 'isUnlimited')
  const isUnlimitedInput = body?.isUnlimited === true
  const previousApiKeyId = String(requestRow.api_key_id || '').trim() || null

  const nameParts = ['CardLobby', requestRow.email || requestRow.user_id || requestId]
  const keyName = nameParts.filter(Boolean).join(' | ').slice(0, 200)

  const issuePayload = {
    keyPrefix,
    replaceApiKeyId: action === 'regenerate' ? previousApiKeyId : null,
  }

  if (action === 'approve') {
    issuePayload.name = keyName
    issuePayload.isUnlimited = hasIsUnlimitedInput ? isUnlimitedInput : false
    if (!issuePayload.isUnlimited) {
      issuePayload.rateLimitPerMin = hasRateInput ? requestedRate : DEFAULT_RATE_LIMIT
    }
  } else {
    if (hasIsUnlimitedInput) {
      issuePayload.isUnlimited = isUnlimitedInput
    }
    if (!isUnlimitedInput && hasRateInput) {
      issuePayload.rateLimitPerMin = requestedRate
    }
    if (!previousApiKeyId && hasIsUnlimitedInput && !isUnlimitedInput && !hasRateInput) {
      issuePayload.rateLimitPerMin = DEFAULT_RATE_LIMIT
    }
  }

  let issuedKey
  try {
    issuedKey = await issueCardhqKey(issuePayload)
  } catch (issueError) {
    res.status(502).json({
      error: getErrorMessage(issueError, 'Failed to issue API key in CardHQ.'),
    })
    return
  }

  let updateQuery = adminClient
    .from('api_key_requests')
    .update({
      status: 'approved',
      reviewed_by: adminUser.id,
      reviewed_at: reviewedAt,
      admin_notes: adminNotes,
      api_key_id: issuedKey.apiKeyId,
      api_key_preview: issuedKey.apiKeyPreview,
    })
    .eq('request_id', requestId)
  updateQuery =
    action === 'approve'
      ? updateQuery.eq('status', 'pending')
      : updateQuery.eq('status', 'approved')
  const { data: approvedRow, error: approveError } = await updateQuery
    .select(REQUEST_COLUMNS)
    .single()

  if (approveError) {
    await revokeCardhqKey(issuedKey.apiKeyId)

    res.status(500).json({
      error: getErrorMessage(approveError, 'Failed to approve request. Generated key was disabled.'),
    })
    return
  }

  if (
    action === 'regenerate' &&
    previousApiKeyId &&
    previousApiKeyId !== issuedKey.apiKeyId
  ) {
    await revokeCardhqKey(previousApiKeyId)
  }

  res.status(200).json({
    ok: true,
    request: approvedRow,
    issuedApiKeyOnce: issuedKey.apiKey,
  })
}
