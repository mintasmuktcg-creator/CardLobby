import { runCollectrImport } from '../scripts/collectr-importer-core.mjs'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(500).json({ error: 'Supabase env vars are missing.' })
    return
  }

  const urlParam = Array.isArray(req.query?.url) ? req.query.url[0] : req.query?.url
  if (!urlParam) {
    res.status(400).json({ error: 'Missing Collectr URL.' })
    return
  }

  const includeNonEnglishRaw = Array.isArray(req.query?.includeNonEnglish)
    ? req.query.includeNonEnglish[0]
    : req.query?.includeNonEnglish
  const includeNonEnglish = ['1', 'true', 'yes', 'on'].includes(
    String(includeNonEnglishRaw || '').toLowerCase(),
  )

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
      includeNonEnglish,
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_KEY,
    })

    res.status(200).json(payload)
  } catch (err) {
    const message = formatError(err)
    const isBadRequest =
      /invalid collectr url|missing collectr url|app.getcollectr.com/i.test(message)
    res.status(isBadRequest ? 400 : 500).json({ error: message })
  }
}
