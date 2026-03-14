import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import type {
  CollectrCollection,
  CollectrImportResult,
  CollectrImportSummary,
  SupabaseSession,
} from '../shared/types'

type CollectrImporterProps = {
  session: SupabaseSession
  onSignIn: () => void
  onSignUp: () => void
}

const COLLECTR_COLLECTIONS_CACHE_KEY = 'cardlobby.collectr.collections'

const formatPrice = (value: number | string | null | undefined) => {
  if (value === undefined || value === null || value === '') return '-'
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return '-'
  return `$${numeric.toFixed(2)}`
}

const formatCheck = (value: boolean | null | undefined) => {
  if (value === null || value === undefined) return '[-]'
  return value ? '[x]' : '[ ]'
}

const getCheckClass = (value: boolean | null | undefined) => {
  if (value === null || value === undefined) return 'muted'
  return value ? 'success' : 'warning'
}

const formatError = (err: unknown): string => {
  if (err === null || err === undefined) return 'Unknown error'
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'object') {
    const maybeMessage = (err as { message?: unknown }).message
    if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) {
      return maybeMessage
    }
    const maybeError = (err as { error?: unknown }).error
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

function CollectrImporter({ session, onSignIn, onSignUp }: CollectrImporterProps) {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [summary, setSummary] = useState<CollectrImportSummary | null>(null)
  const [results, setResults] = useState<CollectrImportResult[]>([])
  const [collections, setCollections] = useState<CollectrCollection[]>([])
  const [selectedCollectionId, setSelectedCollectionId] = useState('')
  const isSignedIn = Boolean(session?.access_token)
  const totalMarketValue = useMemo(() => {
    if (!results.length) return null
    let total = 0
    let hasPrice = false
    results.forEach((row) => {
      const price = row.market_price
      const numeric = typeof price === 'number' ? price : Number(price)
      if (Number.isFinite(numeric)) {
        total += numeric * (row.quantity || 0)
        hasPrice = true
      }
    })
    return hasPrice ? total : null
  }, [results])

  const buildResultsByCollection = (rows: CollectrImportResult[]) => {
    const map: Record<string, CollectrImportResult[]> = {}
    rows.forEach((row) => {
      const key = row.collectr_collection_id || 'unknown'
      if (!map[key]) map[key] = []
      map[key].push(row)
    })
    return map
  }

  const writeCollectionCache = (
    nextCollections: CollectrCollection[],
    nextResults: CollectrImportResult[],
  ) => {
    if (typeof window === 'undefined') return null
    const resultsByCollection = buildResultsByCollection(nextResults)
    const payload = {
      collections: nextCollections,
      resultsByCollection,
    }
    window.localStorage.setItem(
      COLLECTR_COLLECTIONS_CACHE_KEY,
      JSON.stringify(payload),
    )
    return resultsByCollection
  }

  const readCollectionCache = () => {
    if (typeof window === 'undefined') return null
    const raw = window.localStorage.getItem(COLLECTR_COLLECTIONS_CACHE_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as {
        collections?: CollectrCollection[]
        resultsByCollection?: Record<string, CollectrImportResult[]>
      }
    } catch {
      return null
    }
  }

  const applyCollectionFromCache = (
    collectionId: string,
    fallback: CollectrImportResult[],
  ) => {
    const cached = readCollectionCache()
    const next =
      cached?.resultsByCollection?.[collectionId] ??
      cached?.resultsByCollection?.[collectionId || 'unknown']
    if (next) {
      setResults(next)
    } else {
      setResults(fallback)
    }
  }

  const runImport = async () => {
    if (!session?.access_token) {
      setStatus('error')
      setErrorMessage('Sign in to run imports.')
      return
    }

    const trimmed = url.trim()
    if (!trimmed) {
      setErrorMessage('Enter a Collectr profile URL to import.')
      return
    }

    setStatus('loading')
    setErrorMessage(null)
    setSummary(null)
    setResults([])
    setCollections([])
    setSelectedCollectionId('')

    try {
      const params = new URLSearchParams({ url: trimmed })
      const response = await fetch(`/api/collectr-importer?${params.toString()}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      const text = await response.text()

      let payload: {
        summary?: CollectrImportSummary
        results?: CollectrImportResult[]
        collections?: CollectrCollection[]
        error?: string
        message?: string
      } = {}
      try {
        payload = JSON.parse(text)
      } catch {
        const fallback =
          text?.trim() ||
          'Collectr importer API is not available locally. Make sure `npm run dev` is running (or use `vercel dev`/deploy).'
        throw new Error(fallback)
      }

      if (!response.ok) {
        throw new Error(payload?.error || payload?.message || text || 'Import failed.')
      }

      const nextCollections = Array.isArray(payload.collections)
        ? payload.collections
        : []
      const nextResults = Array.isArray(payload.results) ? payload.results : []
      setSummary(payload.summary ?? null)
      setCollections(nextCollections)
      if (nextCollections.length) {
        const defaultId = nextCollections[0]?.id || ''
        const cached = writeCollectionCache(nextCollections, nextResults)
        setSelectedCollectionId(defaultId)
        if (defaultId && cached?.[defaultId]) {
          setResults(cached[defaultId])
        } else {
          setResults(nextResults)
        }
      } else {
        setResults(nextResults)
      }
      setStatus('done')
    } catch (err) {
      setStatus('error')
      setErrorMessage(formatError(err))
    }
  }

  const handleCollectionChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextId = event.target.value
    setSelectedCollectionId(nextId)
    applyCollectionFromCache(nextId, results)
  }

  return (
    <section className="collectr-importer">
      <div className="importer-head">
        <div className="pill">Collectr Importer</div>
        <h2>Import cards from a Collectr showcase</h2>
        <p className="swatch-note">
          Paste a public Collectr profile URL. We will scan the page for product IDs,
          match them against your database, and show the results below.
        </p>
      </div>

      <div className="importer-panel card-surface">
        <form
          className="importer-row"
          onSubmit={(e) => {
            e.preventDefault()
            void runImport()
          }}
        >
          <input
            type="url"
            placeholder="https://app.getcollectr.com/showcase/profile/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={!isSignedIn || status === 'loading'}
          />
          <button
            className="btn primary"
            type="submit"
            disabled={!isSignedIn || status === 'loading'}
          >
            {status === 'loading' ? 'Importing...' : 'Run import'}
          </button>
        </form>
        {!isSignedIn && (
          <div className="api-request-locked">
            <p className="swatch-note">Sign in or create an account to use the importer.</p>
            <div className="cta-row">
              <button className="btn ghost" onClick={onSignIn}>
                Sign in
              </button>
              <button className="btn primary" onClick={onSignUp}>
                Sign up
              </button>
            </div>
          </div>
        )}
        {collections.length > 0 && (
          <div className="importer-row">
            <select
              value={selectedCollectionId}
              onChange={handleCollectionChange}
            >
              {collections.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {errorMessage && <div className="importer-error">{errorMessage}</div>}
        {summary && (
          <div className="importer-summary">
            <div className="summary-card">
              <div className="pill muted">Total market value</div>
              <strong>{formatPrice(totalMarketValue)}</strong>
            </div>
            <div className="summary-card">
              <div className="pill muted">Collectr items</div>
              <strong>{summary.totalCollectr}</strong>
            </div>
            <div className="summary-card">
              <div className="pill muted">Parsed products</div>
              <strong>{summary.parsedProducts}</strong>
            </div>
            <div className="summary-card">
              <div className="pill muted">Matched products</div>
              <strong>{summary.matchedProducts}</strong>
            </div>
            <div className="summary-card">
              <div className="pill muted">Skipped graded</div>
              <strong>{summary.skippedGraded}</strong>
            </div>
          </div>
        )}
      </div>

      <div className="importer-results">
        <div className="importer-results-head">
          <div className="pill muted">Imported cards</div>
          <span className="swatch-note">
            {results.length > 0
              ? `Showing ${results.length} results.`
              : status === 'loading'
                ? 'Importing...'
                : 'Run an import to see results.'}
          </span>
        </div>
        <div className="import-grid">
          {results.map((row, index) => {
            const displayName = row.name || row.collectr_name || 'Unknown product'
            const displaySet = row.set || row.collectr_set || 'Unknown set'
            const imageUrl = row.image_url || row.collectr_image_url || null
            const japaneseChecks = row.japanese_checks ?? null
            const key = row.tcg_product_id
              ? `${row.tcg_product_id}-${row.collectr_set ?? 'set'}`
              : `${index}-${row.collectr_set ?? 'set'}`
            return (
              <article
                key={key}
                className={`import-card${row.matched ? '' : ' unmatched'}`}
              >
                <div className="import-card-media">
                  {imageUrl ? (
                    <img src={imageUrl} alt={displayName} loading="lazy" />
                  ) : (
                    <div className="img-placeholder">No image</div>
                  )}
                  <div className="import-card-badge">
                    <span className="pill qty-badge">Qty {row.quantity}</span>
                  </div>
                </div>
                <div className="import-card-body">
                  <div className="import-card-title">{displayName}</div>
                  <div className="import-card-meta">
                    <span>{displaySet}</span>
                  </div>
                  <div className="import-card-meta">
                    <span>#{row.card_number || '-'}</span>
                    <span className="dot">|</span>
                    <span>{row.rarity || '-'}</span>
                  </div>
                  <div className="import-card-meta">
                    <span>{row.product_type || '-'}</span>
                    <span className="dot">|</span>
                    <span>{formatPrice(row.market_price)}</span>
                  </div>
                  <div className="import-card-meta">
                    <span>Collectr condition: {row.collectr_condition || '-'}</span>
                    <span className="dot">|</span>
                    <span>Matched condition: {row.condition || '-'}</span>
                  </div>
                  <div className="import-card-meta">
                    <span className={`pill ${row.matched ? 'success' : 'warning'}`}>
                      {row.matched ? 'Matched' : 'Unmatched'}
                    </span>
                  </div>
                  {japaneseChecks && (
                    <div className="import-card-meta">
                      <span className={`pill ${getCheckClass(japaneseChecks.set_match)}`}>
                        Set {formatCheck(japaneseChecks.set_match)}
                      </span>
                      <span
                        className={`pill ${getCheckClass(
                          japaneseChecks.card_number_match,
                        )}`}
                      >
                        Number {formatCheck(japaneseChecks.card_number_match)}
                      </span>
                      <span className={`pill ${getCheckClass(japaneseChecks.name_match)}`}>
                        Name {formatCheck(japaneseChecks.name_match)}
                      </span>
                    </div>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}


export default CollectrImporter
