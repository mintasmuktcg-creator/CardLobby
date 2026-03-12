import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const SUPABASE_AUTH_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY
const REQUEST_COLUMNS =
  'request_id, user_id, email, reason, status, source_ip, user_agent, created_at, reviewed_at, admin_notes, api_key_id, api_key_preview'

const MIN_REASON_LENGTH = 10
const MAX_REASON_LENGTH = 2000

const getJsonBody = (req) => {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string' && req.body.trim().length > 0) {
    return JSON.parse(req.body)
  }
  return {}
}

const extractToken = (req) => {
  const header = req.headers?.authorization || ''
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim()
  }
  return null
}

const getSupabaseErrorMessage = (err, fallback) => {
  if (!err) return fallback
  if (typeof err === 'string') return err
  if (typeof err === 'object') {
    if (typeof err.message === 'string' && err.message) return err.message
    if (typeof err.error === 'string' && err.error) return err.error
  }
  return fallback
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

  const token = extractToken(req)
  if (!token) {
    res.status(401).json({ error: 'Missing authorization token.' })
    return
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_AUTH_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data, error } = await authClient.auth.getUser(token)
  if (error || !data?.user) {
    res.status(401).json({ error: 'Invalid or expired session.' })
    return
  }

  try {
    const readClient = SUPABASE_ANON_KEY
      ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${token}` } },
        })
      : authClient

    const { data: existingRequest, error: existingError } = await readClient
      .from('api_key_requests')
      .select(REQUEST_COLUMNS)
      .eq('user_id', data.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingError) {
      throw existingError
    }

    if (req.method === 'GET') {
      res.status(200).json({ ok: true, request: existingRequest || null })
      return
    }

    if (existingRequest) {
      res.status(200).json({
        ok: true,
        existing: true,
        request: existingRequest,
        message: 'You have already submitted an API key request.',
      })
      return
    }

    let body = {}
    try {
      body = getJsonBody(req)
    } catch {
      res.status(400).json({ error: 'Invalid JSON payload.' })
      return
    }

    const reason = String(body?.reason || '').trim()
    if (reason.length < MIN_REASON_LENGTH) {
      res.status(400).json({ error: 'Reason is too short.' })
      return
    }
    if (reason.length > MAX_REASON_LENGTH) {
      res.status(400).json({ error: 'Reason is too long.' })
      return
    }

    const ip =
      (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      'unknown'

    const insertClient = SUPABASE_ANON_KEY
      ? readClient
      : authClient

    const { data: createdRequest, error: insertError } = await insertClient
      .from('api_key_requests')
      .insert({
        user_id: data.user.id,
        email: data.user.email || null,
        reason,
        source_ip: ip,
        user_agent: req.headers['user-agent'] || null,
      })
      .select(REQUEST_COLUMNS)
      .single()

    if (insertError) {
      // Race-safe fallback if two requests arrive together and unique user_id wins.
      if (insertError.code === '23505') {
        const { data: existingAfterConflict } = await readClient
          .from('api_key_requests')
          .select(REQUEST_COLUMNS)
          .eq('user_id', data.user.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        res.status(200).json({
          ok: true,
          existing: true,
          request: existingAfterConflict || null,
          message: 'You have already submitted an API key request.',
        })
        return
      }
      throw insertError
    }

    res.status(200).json({ ok: true, existing: false, request: createdRequest })
    return
  } catch (dbError) {
    res
      .status(500)
      .json({ error: getSupabaseErrorMessage(dbError, 'Failed to process request.') })
    return
  }
}
