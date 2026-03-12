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

const extractToken = (req) => {
  const header = req.headers?.authorization || ''
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim()
  }
  return null
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!SUPABASE_URL || !SUPABASE_AUTH_KEY) {
    res.status(500).json({ error: 'Supabase env vars are missing.' })
    return
  }

  if (ADMIN_USER_IDS.size === 0) {
    res.status(500).json({ error: 'ADMIN_USER_IDS is not configured.' })
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

  const isAdmin = ADMIN_USER_IDS.has(String(data.user.id || ''))

  res.status(200).json({ ok: true, isAdmin })
}
