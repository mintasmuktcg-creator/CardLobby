import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY

const RESEND_API_KEY = process.env.RESEND_API_KEY
const EMAIL_TO = process.env.API_KEY_REQUEST_TO || 'MintAsMukTCG@gmail.com'
const EMAIL_FROM =
  process.env.API_KEY_REQUEST_FROM || 'Card Lobby <api@cardlobby.app>'

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

const sendEmail = async ({ subject, text }) => {
  if (!RESEND_API_KEY) {
    throw new Error('Missing RESEND_API_KEY.')
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [EMAIL_TO],
      subject,
      text,
    }),
  })

  if (!response.ok) {
    const details = await response.text().catch(() => '')
    throw new Error(details || 'Email provider returned an error.')
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(500).json({ error: 'Supabase env vars are missing.' })
    return
  }

  const token = extractToken(req)
  if (!token) {
    res.status(401).json({ error: 'Missing authorization token.' })
    return
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data?.user) {
    res.status(401).json({ error: 'Invalid or expired session.' })
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

  const subject = `Card Lobby API key request — ${data.user.email || data.user.id}`
  const text = [
    'Card Lobby API key request',
    '',
    `Email: ${data.user.email || 'unknown'}`,
    `User ID: ${data.user.id}`,
    `Submitted: ${new Date().toISOString()}`,
    `IP: ${ip}`,
    '',
    'Reason:',
    reason,
  ].join('\n')

  try {
    await sendEmail({ subject, text })
  } catch (mailError) {
    res.status(502).json({ error: mailError.message || 'Failed to send email.' })
    return
  }

  res.status(200).json({ ok: true })
}
