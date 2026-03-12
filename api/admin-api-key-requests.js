import crypto from 'node:crypto'
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
const API_KEY_PEPPER = process.env.API_KEY_PEPPER || ''

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

const generateApiKey = (prefix) => {
  const token = crypto.randomBytes(24).toString('hex')
  return `${prefix}_${token}`
}

const toApiKeyPreview = (rawKey) => {
  const value = String(rawKey || '').trim()
  if (!value) return null
  if (value.length <= 12) return value
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

const hashApiKey = (rawKey) => {
  const value = String(rawKey || '').trim()
  if (!value) return null
  const hasher = API_KEY_PEPPER
    ? crypto.createHmac('sha256', API_KEY_PEPPER)
    : crypto.createHash('sha256')
  return hasher.update(value).digest('hex')
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

  let existingKey = null
  if (action === 'regenerate' && requestRow.api_key_id) {
    const { data: existingKeyData, error: existingKeyError } = await adminClient
      .from('api_keys')
      .select('api_key_id, name, rate_limit_per_min, is_unlimited')
      .eq('api_key_id', requestRow.api_key_id)
      .maybeSingle()

    if (existingKeyError) {
      res.status(500).json({ error: getErrorMessage(existingKeyError, 'Failed to load existing key.') })
      return
    }
    existingKey = existingKeyData || null
  }

  const hasIsUnlimitedInput = Object.prototype.hasOwnProperty.call(body || {}, 'isUnlimited')
  const isUnlimited = hasIsUnlimitedInput
    ? body?.isUnlimited === true
    : action === 'regenerate'
      ? Boolean(existingKey?.is_unlimited)
      : false
  const rateLimitPerMin = isUnlimited
    ? null
    : requestedRate ??
      (action === 'regenerate' && existingKey
        ? toInt(existingKey.rate_limit_per_min) ?? DEFAULT_RATE_LIMIT
        : DEFAULT_RATE_LIMIT)

  const rawApiKey = generateApiKey(keyPrefix)
  const keyHash = hashApiKey(rawApiKey)
  if (!keyHash) {
    res.status(500).json({ error: 'Failed to generate API key hash.' })
    return
  }
  const apiKeyPreview = toApiKeyPreview(rawApiKey)

  const nameParts = ['CardLobby', requestRow.email || requestRow.user_id || requestId]
  const keyName = (action === 'regenerate' && existingKey?.name
    ? existingKey.name
    : nameParts.filter(Boolean).join(' | ')
  ).slice(0, 200)

  const { data: keyRow, error: keyInsertError } = await adminClient
    .from('api_keys')
    .insert({
      name: keyName,
      key_hash: keyHash,
      rate_limit_per_min: rateLimitPerMin,
      is_unlimited: isUnlimited,
      is_active: true,
    })
    .select('api_key_id')
    .single()

  if (keyInsertError) {
    res
      .status(500)
      .json({ error: getErrorMessage(keyInsertError, 'Failed to create API key record.') })
    return
  }

  let updateQuery = adminClient
    .from('api_key_requests')
    .update({
      status: 'approved',
      reviewed_by: adminUser.id,
      reviewed_at: reviewedAt,
      admin_notes: adminNotes,
      api_key_id: keyRow.api_key_id,
      api_key_preview: apiKeyPreview,
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
    await adminClient
      .from('api_keys')
      .update({ is_active: false })
      .eq('api_key_id', keyRow.api_key_id)

    res.status(500).json({
      error: getErrorMessage(approveError, 'Failed to approve request. Generated key was disabled.'),
    })
    return
  }

  const previousApiKeyId = requestRow.api_key_id
  if (action === 'regenerate' && previousApiKeyId && previousApiKeyId !== keyRow.api_key_id) {
    await adminClient.from('api_keys').update({ is_active: false }).eq('api_key_id', previousApiKeyId)
  }

  res.status(200).json({
    ok: true,
    request: approvedRow,
    issuedApiKeyOnce: rawApiKey,
  })
}
