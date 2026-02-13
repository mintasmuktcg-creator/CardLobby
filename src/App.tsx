import { useEffect, useMemo, useState } from 'react'
import Papa from 'papaparse'
import setCsv from '../CardCSVs/MEAscendedHeroesProductsAndPrices.csv?raw'
import { supabase } from './lib/supabaseClient'
import './App.css'

const CSV_FALLBACK_SET_TITLE = 'Mega Evolution — Ascended Heroes'

type CardSetDbRow = {
  id: string
  name: string
  code: string | null
  release_date?: string | null
  generation?: number | null
}

type ProductDbRow = {
  tcg_product_id: number | null
  set_id: string | null
  name: string
  clean_name: string | null
  product_type: string | null
  subtype: string | null
  card_number: string | null
  rarity: string | null
  card_type: string | null
  hp: string | null
  stage: string | null
  attack1: string | null
  attack2: string | null
  weakness: string | null
  resistance: string | null
  retreat_cost: string | null
  image_url: string | null
  image_count: number | null
  external_url: string | null
  modified_on: string | null
  low_price?: number | null
  mid_price?: number | null
  high_price?: number | null
  market_price?: number | null
  direct_low_price?: number | null
  price_updated_at?: string | null
  currency?: string | null
  card_sets?:
    | { id: string; name: string; code: string | null }
    | { id: string; name: string; code: string | null }[]
    | null
}

type CardRow = {
  productId: number
  productType?: string | null
  name: string
  cleanName: string
  imageUrl?: string | null
  setId?: string | null
  setName?: string | null
  categoryId?: number | null
  groupId?: number | null
  lowPrice?: number | null
  midPrice?: number | null
  highPrice?: number | null
  marketPrice?: number | null
  extNumber?: string | null
  extRarity?: string | null
  extCardType?: string | null
  extCardText?: string | null
  extAttack1?: string | null
  extAttack2?: string | null
  imageCount?: number | null
  subTypeName?: string | null
  extHP?: string | null
  extStage?: string | null
  extWeakness?: string | null
  extResistance?: string | null
  extRetreatCost?: string | null
  url?: string | null
  modifiedOn?: string | null
  directLowPrice?: number | null
}

function formatPrice(value: number | null | undefined) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—'
  return `$${value.toFixed(2)}`
}

function parseCardNumber(extNumber?: string | number | null): number | null {
  if (extNumber === undefined || extNumber === null) return null
  if (typeof extNumber === 'number' && Number.isFinite(extNumber)) {
    return extNumber
  }
  if (typeof extNumber === 'string') {
    // Examples: "175/217", "001/099", "180"
    const match = extNumber.match(/(\d{1,4})\s*\/\s*(\d{1,4})/)?.[1]
    if (match) return Number(match)
    // If only a number (no slash) and at least 1 digit, accept it too.
    const solo = extNumber.match(/^\s*(\d{1,4})\s*$/)?.[1]
    if (solo) return Number(solo)
    // Fallback: grab the first digit run anywhere in the string.
    const loose = extNumber.match(/(\d{1,4})/)
    if (loose) return Number(loose[1])
    // Otherwise, treat as no number.
    return null
  }
  return null
}

function normalizeCardNumber(value?: string | number | null) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return value.trim()
  return ''
}

function getCardNumberSortKey(value?: string | number | null) {
  const raw = normalizeCardNumber(value)
  if (!raw) {
    return { group: 2, number: Number.POSITIVE_INFINITY, prefix: '', raw: '' }
  }

  const numericOnly = /^\d{1,4}(?:\s*\/\s*\d{1,4})?$/.test(raw)
  if (numericOnly) {
    return { group: 0, number: parseCardNumber(raw) ?? Number.POSITIVE_INFINITY, prefix: '', raw }
  }

  const match = raw.match(/^([A-Za-z]+)\s*([0-9]{1,4})/)
  const prefix = match?.[1]?.toUpperCase() ?? raw.toUpperCase()
  const number = match?.[2] ? Number(match[2]) : Number.POSITIVE_INFINITY
  return { group: 1, number, prefix, raw }
}

function compareCardOrder(a: CardRow, b: CardRow) {
  const aKey = getCardNumberSortKey(a.extNumber)
  const bKey = getCardNumberSortKey(b.extNumber)
  if (aKey.group !== bKey.group) return aKey.group - bKey.group

  if (aKey.group === 0) {
    if (aKey.number !== bKey.number) return aKey.number - bKey.number
    return aKey.raw.localeCompare(bKey.raw)
  }

  if (aKey.prefix !== bKey.prefix) return aKey.prefix.localeCompare(bKey.prefix)
  if (aKey.number !== bKey.number) return aKey.number - bKey.number
  return aKey.raw.localeCompare(bKey.raw)
}

function getCardKey(card: CardRow) {
  return `${card.productId}-${card.extNumber ?? 'na'}`
}

function normalizeSubtype(value?: string | null) {
  return (value || 'Other').trim() || 'Other'
}

function isSingleCard(card: CardRow) {
  if (card.productType) return card.productType === 'single'
  const numberParsed = parseCardNumber(card.extNumber)
  return numberParsed !== null
}

const chunk = <T,>(arr: T[], size: number) => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

type UploadStatus =
  | { state: 'idle' }
  | { state: 'parsing' }
  | { state: 'uploading'; progress: string }
  | { state: 'done'; message: string }
  | { state: 'error'; message: string }

type SetInfo = {
  id: string
  name: string
  code?: string | null
  releaseDate?: string | null
  generation?: number | null
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

function toIso(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return new Date().toISOString()
}

function formatError(err: unknown): string {
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

function hydrateCards(
  rows: CardRow[],
  setCardsFn?: (r: CardRow[]) => void,
  setSubtypesFn?: (s: string[]) => void,
  setFiltersFn?: (s: Set<string>) => void,
) {
  const sorted = rows.sort((a: CardRow, b: CardRow) => {
    const byNumber = compareCardOrder(a, b)
    if (byNumber !== 0) return byNumber
    return (a.name || '').localeCompare(b.name || '')
  })
  const subtypeSet = new Set<string>()
  sorted.forEach((row) => {
    if (!isSingleCard(row)) return
    subtypeSet.add(normalizeSubtype(row.subTypeName))
  })
  const subtypeList = Array.from(subtypeSet).sort((a, b) => a.localeCompare(b))
  if (setCardsFn) setCardsFn(sorted)
  if (setSubtypesFn) setSubtypesFn(subtypeList)
  if (setFiltersFn) setFiltersFn(new Set(subtypeList))
}

function App() {
  const [cards, setCards] = useState<CardRow[]>([])
  const [sets, setSets] = useState<SetInfo[]>([])
  const [selectedSetId, setSelectedSetId] = useState<string>('all')
  const [viewMode, setViewMode] = useState<'singles' | 'sealed' | 'all'>(
    'singles',
  )
  const [availableSubtypes, setAvailableSubtypes] = useState<string[]>([])
  const [subtypeFilters, setSubtypeFilters] = useState<Set<string>>(new Set())
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin')
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [session, setSession] = useState<Awaited<
    ReturnType<typeof supabase.auth.getSession>
  >['data']['session']>(null)
  const adminEmail = import.meta.env.VITE_ADMIN_EMAIL || ''
  const [path, setPath] = useState(window.location.pathname)
  const [loadMessage, setLoadMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [caughtCards, setCaughtCards] = useState<Record<string, boolean>>({})
  const [confirmAction, setConfirmAction] = useState<'catch' | 'release' | null>(null)

  useEffect(() => {
    const hasSupabaseEnv =
      !!import.meta.env.VITE_SUPABASE_URL && !!import.meta.env.VITE_SUPABASE_ANON_KEY

    const fromCsvFallback = () => {
      setLoading(true)
      Papa.parse<CardRow>(setCsv, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true,
        complete: (result) => {
          const parsed = (result.data || []).filter(
            (row: CardRow) => !!row.productId,
          )
          hydrateCards(parsed, setCards, setAvailableSubtypes, setSubtypeFilters)
          setSets([{ id: 'csv-set', name: CSV_FALLBACK_SET_TITLE }])
          setSelectedSetId('csv-set')
          setLoadMessage('Loaded from local CSV fallback.')
          setLoading(false)
        },
        error: (err: Error) => {
          setLoadMessage(`CSV load failed: ${err.message}`)
          setLoading(false)
        },
      })
    }

    const fromSupabase = async () => {
      if (!hasSupabaseEnv) {
        fromCsvFallback()
        return
      }
      setLoading(true)

      // Fetch sets first. Selecting a set triggers loading its products.
      const { data, error } = await supabase
        .from('card_sets')
        .select('*')
        .order('name', { ascending: true })

      if (error) {
        setLoadMessage(
          `Supabase load failed (${error?.message ?? 'unknown error'}); falling back to CSV.`,
        )
        fromCsvFallback()
        return
      }

      const setRows = Array.isArray(data) ? (data as unknown as CardSetDbRow[]) : []

      const setList: SetInfo[] = setRows.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code ?? null,
        releaseDate: r.release_date ?? null,
        generation: typeof r.generation === 'number' ? r.generation : null,
      }))

      // Sort: generation (1-9), then release date, then name.
      setList.sort((a, b) => {
        const aGen = a.generation ?? 999
        const bGen = b.generation ?? 999
        if (aGen !== bGen) return aGen - bGen

        const aDate = a.releaseDate ? Date.parse(a.releaseDate) : Number.POSITIVE_INFINITY
        const bDate = b.releaseDate ? Date.parse(b.releaseDate) : Number.POSITIVE_INFINITY
        if (aDate !== bDate) return aDate - bDate

        return a.name.localeCompare(b.name)
      })

      setSets(setList)

      const saved = localStorage.getItem('cardlobby.selected_set_id')
      const savedExists = !!saved && setList.some((s) => s.id === saved)
      const defaultId =
        (savedExists ? saved : null) ||
        setList.find((s) => s.name.toLowerCase().includes('ascended heroes'))?.id ||
        setList[0]?.id ||
        'all'

      setSelectedSetId(defaultId)
      setLoadMessage(`Loaded ${setList.length} sets from Supabase.`)
      setLoading(false)
    }

    fromSupabase()
  }, [])

  useEffect(() => {
    const hasSupabaseEnv =
      !!import.meta.env.VITE_SUPABASE_URL && !!import.meta.env.VITE_SUPABASE_ANON_KEY
    if (!hasSupabaseEnv) return

    // CSV fallback mode (used when Supabase can't load). Don't try to query Supabase by set_id.
    if (selectedSetId === 'csv-set') return

    if (!selectedSetId || selectedSetId === 'all') {
      localStorage.removeItem('cardlobby.selected_set_id')
      setCards([])
      setAvailableSubtypes([])
      setSubtypeFilters(new Set())
      return
    }

    localStorage.setItem('cardlobby.selected_set_id', selectedSetId)

    let cancelled = false

    const loadSet = async () => {
      setLoading(true)
      setCards([])
      setAvailableSubtypes([])
      setSubtypeFilters(new Set())

      try {
        const pageSize = 1000
        let from = 0
        const all: ProductDbRow[] = []

        while (true) {
          setLoadMessage(`Loading set… (${all.length} loaded)`)

          const { data, error } = await supabase
            .from('products')
            .select(
              'id, tcg_product_id, set_id, name, clean_name, product_type, subtype, card_number, rarity, card_type, hp, stage, attack1, attack2, weakness, resistance, retreat_cost, image_url, image_count, external_url, modified_on, low_price, mid_price, high_price, market_price, direct_low_price, price_updated_at, currency, card_sets(id,name,code)',
            )
            .eq('set_id', selectedSetId)
            .order('tcg_product_id', { ascending: true })
            .range(from, from + pageSize - 1)

          if (error) throw error
          const page = Array.isArray(data) ? (data as unknown as ProductDbRow[]) : []
          if (page.length === 0) break
          all.push(...page)
          if (page.length < pageSize) break
          from += pageSize
        }

        if (cancelled) return

        const mapped: CardRow[] = all.map((product) => {
          const setEmbed = Array.isArray(product?.card_sets)
            ? product?.card_sets[0] ?? null
            : product?.card_sets ?? null
          return {
            productId: product?.tcg_product_id ?? 0,
            productType: product?.product_type ?? null,
            name: product?.name ?? 'Unknown product',
            cleanName: product?.clean_name ?? product?.name ?? 'Unknown product',
            setId: product?.set_id ?? setEmbed?.id ?? null,
            setName: setEmbed?.name ?? null,
            imageUrl: product?.image_url ?? null,
            lowPrice: product?.low_price ?? null,
            midPrice: product?.mid_price ?? null,
            highPrice: product?.high_price ?? null,
            marketPrice: product?.market_price ?? null,
            directLowPrice: product?.direct_low_price ?? null,
            extNumber: product?.card_number ?? null,
            extRarity: product?.rarity ?? null,
            extCardType: product?.card_type ?? null,
            extAttack1: product?.attack1 ?? null,
            extAttack2: product?.attack2 ?? null,
            extWeakness: product?.weakness ?? null,
            extResistance: product?.resistance ?? null,
            extRetreatCost: product?.retreat_cost ?? null,
            extHP: product?.hp ?? null,
            extStage: product?.stage ?? null,
            imageCount: product?.image_count ?? null,
            subTypeName: product?.subtype ?? null,
            url: product?.external_url ?? null,
            modifiedOn: product?.modified_on ?? null,
          }
        })

        hydrateCards(mapped, setCards, setAvailableSubtypes, setSubtypeFilters)
        setLoadMessage(`Loaded ${mapped.length} products from Supabase.`)
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err)
          setLoadMessage(`Failed to load set: ${message}`)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadSet()

    return () => {
      cancelled = true
    }
  }, [selectedSetId])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, currentSession) => setSession(currentSession),
    )
    return () => {
      listener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const isAdmin =
    !!session?.user?.email &&
    adminEmail.length > 0 &&
    session.user.email.toLowerCase() === adminEmail.toLowerCase()

  const isAdminRoute = path === '/admin'

  const go = (to: string) => {
    if (window.location.pathname !== to) {
      window.history.pushState({}, '', to)
      setPath(to)
    }
  }

  const filteredCards = useMemo(() => {
    return cards.filter((card) => {
      const single = isSingleCard(card)
      if (viewMode === 'singles' && !single) return false
      if (viewMode === 'sealed' && single) return false
      if (single && subtypeFilters.size > 0) {
        const label = normalizeSubtype(card.subTypeName)
        if (!subtypeFilters.has(label)) return false
      }
      return true
    })
  }, [cards, viewMode, subtypeFilters])

  const visibleCards = useMemo(() => {
    const sorted = [...filteredCards].sort((a, b) => {
      const byNumber = compareCardOrder(a, b)
      if (byNumber !== 0) return byNumber
      return (a.name || '').localeCompare(b.name || '')
    })
    return sorted
  }, [filteredCards])

  const bulkSetCaught = (nextValue: boolean) => {
    setCaughtCards((prev) => {
      const next = { ...prev }
      visibleCards.forEach((card) => {
        next[getCardKey(card)] = nextValue
      })
      return next
    })
  }

  const totalValue = useMemo(() => {
    return visibleCards.reduce((sum, card) => {
      const price = card.marketPrice ?? card.midPrice ?? card.lowPrice ?? 0
      return sum + (Number.isFinite(price) ? price : 0)
    }, 0)
  }, [visibleCards])

  if (isAdminRoute) {
    return (
      <div className="page">
        <nav className="nav">
          <div className="brand">Card Lobby — Admin</div>
          <div className="nav-actions">
            <button className="btn ghost" onClick={() => go('/')}>
              Back to app
            </button>
            {session ? (
              <>
                <div className="pill muted">
                  {session.user.email}
                  {isAdmin ? ' · Admin' : ''}
                </div>
                <button
                  className="btn ghost"
                  onClick={() => {
                    supabase.auth.signOut()
                    go('/')
                  }}
                >
                  Sign out
                </button>
              </>
            ) : null}
          </div>
        </nav>

        {!session || !isAdmin ? (
          <div className="card-surface denial">
            <div className="pill muted">Access denied</div>
            <p>You must be signed in as the admin to view this page.</p>
            <button className="btn primary" onClick={() => go('/')}>
              Go to sign in
            </button>
          </div>
        ) : (
          <AdminPortal />
        )}
      </div>
    )
  }

  const currentSet = sets.find((s) => s.id === selectedSetId) || null
  const setTitle =
    currentSet?.name || (selectedSetId === 'csv-set' ? CSV_FALLBACK_SET_TITLE : 'Select a set')

  return (
    <div className="page">
      <nav className="nav">
        <div className="brand">Card Lobby</div>
        <div className="nav-actions">
          {session ? (
            <>
              <div className="pill muted">
                {session.user.email}
                {isAdmin ? ' · Admin' : ''}
              </div>
              {isAdmin && (
                <button className="btn ghost" onClick={() => go('/admin')}>
                  Admin
                </button>
              )}
              <button
                className="btn ghost"
                onClick={() => {
                  supabase.auth.signOut()
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <button
                className={authMode === 'signin' ? 'btn ghost active' : 'btn ghost'}
                onClick={() => {
                  setAuthMode('signin')
                  setAuthMessage(null)
                }}
              >
                Sign in
              </button>
              <button
                className={authMode === 'signup' ? 'btn primary' : 'btn ghost'}
                onClick={() => {
                  setAuthMode('signup')
                  setAuthMessage(null)
                }}
              >
                Sign up
              </button>
            </>
          )}
        </div>
      </nav>

      <h1 className="headline">
        A Muk-inspired home for trading card buyers, sellers, and collectors.
      </h1>
      <p className="lede">
        Sticky pricing insights, gooey-fast deck building, and collections that
        stay organized even when the market gets messy.
      </p>
      {loadMessage && <div className="load-note">{loadMessage}</div>}

      {!session && (
        <form
          className="auth-form card-surface"
          onSubmit={async (e) => {
            e.preventDefault()
            setAuthMessage(null)
            if (authMode === 'signin') {
              const { error } = await supabase.auth.signInWithPassword({
                email,
                password,
              })
              if (error) setAuthMessage(error.message)
            } else {
              const { data, error } = await supabase.auth.signUp({
                email,
                password,
              })
              if (error) setAuthMessage(error.message)
              else if (data.user) {
                setAuthMessage('Check your email to confirm sign-up (if required).')
              }
            }
          }}
        >
          <div className="auth-form-head">
            <div className="pill">{authMode === 'signin' ? 'Sign in' : 'Sign up'}</div>
            <span className="swatch-note">
              {authMode === 'signin'
                ? 'Use your existing Card Lobby account'
                : 'Create an account to access collections and admin tools'}
            </span>
          </div>
          <div className="auth-fields">
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="auth-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setAuthMode(authMode === 'signin' ? 'signup' : 'signin')
                setAuthMessage(null)
              }}
            >
              {authMode === 'signin' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
            </button>
            <button className="btn primary" type="submit">
              {authMode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </div>
          {authMessage && <div className="auth-message">{authMessage}</div>}
        </form>
      )}

      {isAdmin && (
        <div className="admin-banner">
          <div>
            <div className="pill">Admin</div>
            <strong>Admin portal</strong> — future controls for imports, price
            refresh, and store settings will live here.
          </div>
          <button className="btn ghost" disabled>
            Coming soon
          </button>
        </div>
      )}

      <section className="set-hero">
        <div>
          <div className="pill muted">Set preview</div>
          <h2>{setTitle}</h2>
          <p>
            {selectedSetId === 'all'
              ? 'Choose a set to load its products.'
              : cards.length
                ? `${cards.length} products loaded.`
                : loading
                  ? 'Loading products…'
                  : 'No products loaded yet.'}
          </p>
          {cards.length ? (
            <div className="set-metrics">
              <div className="metric">
                <span className="metric-label">Items</span>
                <span className="metric-value">{visibleCards.length}</span>
              </div>
              <div className="metric">
                <span className="metric-label">Sum of market prices</span>
                <span className="metric-value">
                  {formatPrice(totalValue || 0)}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="cards-section">
        <div className="cards-header">
          <div>
            <div className="pill">Ascending order</div>
            <h3>Browse the set</h3>
          </div>
          <div className="segmented">
            <button
              className={viewMode === 'singles' ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setViewMode('singles')}
            >
              Singles
            </button>
            <button
              className={viewMode === 'sealed' ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setViewMode('sealed')}
            >
              Sealed / kits
            </button>
            <button
              className={viewMode === 'all' ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setViewMode('all')}
            >
              All
            </button>
          </div>
        </div>

        <div className="filter-row">
          <div className="pill">Set</div>
          <select
            className="select"
            value={selectedSetId}
            onChange={(e) => setSelectedSetId(e.target.value)}
          >
            <option value="all">Choose a set…</option>
            {sets.map((set) => (
              <option key={set.id} value={set.id}>
                {set.name}
              </option>
            ))}
          </select>
          <div className="bulk-actions">
            <button
              className="btn ghost small"
              type="button"
              onClick={() => setConfirmAction('catch')}
              disabled={visibleCards.length === 0}
            >
              Catch all
            </button>
            <button
              className="btn ghost small"
              type="button"
              onClick={() => setConfirmAction('release')}
              disabled={visibleCards.length === 0}
            >
              Release all
            </button>
          </div>
        </div>

        {availableSubtypes.length > 0 && (
          <div className="chip-row">
            {availableSubtypes.map((subtype) => {
              const active = subtypeFilters.has(subtype)
              return (
                <button
                  key={subtype}
                  className={active ? 'chip active' : 'chip'}
                  onClick={() => {
                    const next = new Set(subtypeFilters)
                    if (active) {
                      next.delete(subtype)
                    } else {
                      next.add(subtype)
                    }
                    if (next.size === 0) {
                      availableSubtypes.forEach((value) => next.add(value))
                    }
                    setSubtypeFilters(next)
                  }}
                >
                  {subtype}
                </button>
              )
            })}
          </div>
        )}

        <div className="cards-grid">
          {loading && <div className="card-tile loading">Loading set…</div>}
          {!loading && visibleCards.length === 0 && (
            <div className="card-tile loading">No items found.</div>
          )}
          {visibleCards.map((card) => {
            const cardKey = getCardKey(card)
            const isCaught = !!caughtCards[cardKey]
            return (
            <article
              className="card-tile"
              key={cardKey}
            >
              <div className="card-media">
                <button
                  type="button"
                  className={`pokeball-toggle${isCaught ? ' caught' : ''}`}
                  aria-pressed={isCaught}
                  aria-label={isCaught ? 'Mark as not caught' : 'Mark as caught'}
                  onClick={() => {
                    setCaughtCards((prev) => ({
                      ...prev,
                      [cardKey]: !isCaught,
                    }))
                  }}
                >
                  <span className="pokeball" />
                </button>
                {card.imageUrl ? (
                  <img src={card.imageUrl} alt={card.name} loading="lazy" />
                ) : (
                  <div className="img-placeholder">No image</div>
                )}
                <div className="card-badge">#{card.extNumber ?? '—'}</div>
              </div>
              <div className="card-body">
                <div className="card-title">{card.name}</div>
                <div className="card-meta">
                  <span>{card.extRarity || '—'}</span>
                  <span>•</span>
                  <span>{card.extCardType || '—'}</span>
                </div>
                <div className="price-row">
                  <span className="price-label">Market</span>
                  <span className="price-value primary">
                    {formatPrice(card.marketPrice)}
                  </span>
                </div>
                <div className="price-row subtle">
                  <span className="price-label">Mid</span>
                  <span className="price-value">{formatPrice(card.midPrice)}</span>
                </div>
                <div className="price-row subtle">
                  <span className="price-label">Low</span>
                  <span className="price-value">{formatPrice(card.lowPrice)}</span>
                </div>
              </div>
            </article>
            )
          })}
        </div>
      </section>

      {confirmAction && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="pill muted">Confirm</div>
            <h3>
              {confirmAction === 'catch'
                ? 'Catch every visible card?'
                : 'Release every visible card?'}
            </h3>
            <p className="swatch-note">
              {confirmAction === 'catch'
                ? 'This will mark every card currently shown as caught.'
                : 'This will unmark every card currently shown.'}
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirmAction(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  bulkSetCaught(confirmAction === 'catch')
                  setConfirmAction(null)
                }}
              >
                {confirmAction === 'catch' ? 'Catch all' : 'Release all'}
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="palette">
        <div className="palette-header">
          <span className="pill muted">Muk palette</span>
          <span className="swatch-note">Use these in future components</span>
        </div>
        <div className="swatches">
          <div className="swatch sludge">
            <div className="tone">#6b2a7c</div>
            <div className="label">Sludge base</div>
          </div>
          <div className="swatch ooze">
            <div className="tone">#b8f000</div>
            <div className="label">Toxic pop</div>
          </div>
          <div className="swatch ink">
            <div className="tone">#1c0b26</div>
            <div className="label">Shadow</div>
          </div>
          <div className="swatch mist">
            <div className="tone">#f3ecff</div>
            <div className="label">Highlight</div>
          </div>
        </div>
      </section>
    </div>
  )
}

export default App

function AdminPortal() {
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<UploadStatus>({ state: 'idle' })
  const [tcgTypeName, setTcgTypeName] = useState('Pokémon TCG')
  const [setName, setSetName] = useState('Mega Evolution — Ascended Heroes')
  const [setCode, setSetCode] = useState('MEA')
  const [replaceProducts, setReplaceProducts] = useState(false)

  const handleUpload = () => {
    if (!file) return
    setStatus({ state: 'parsing' })

    Papa.parse<CardRow>(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      complete: async (result) => {
        const rows: CardRow[] = (result.data || []).filter((r) => r.productId)
        try {
          // Derive set/group/category ids from the CSV
          const first = rows[0]
          const tcgCategoryId = first?.categoryId ?? null
          const tcgGroupId = first?.groupId ?? null

          // Upsert TCG type
          const { data: typeData, error: typeError } = await supabase
            .from('tcg_types')
            .upsert({ name: tcgTypeName }, { onConflict: 'name' })
            .select('id')
            .single()
          if (typeError) throw typeError
          const categoryId = typeData.id

          // Upsert set
          const { data: setData, error: setError } = await supabase
            .from('card_sets')
            .upsert(
              {
                name: setName,
                code: setCode || null,
                tcg_type_id: categoryId,
                tcg_group_id: tcgGroupId,
                tcg_category_id: tcgCategoryId,
              },
              { onConflict: 'code' },
            )
            .select('id')
            .single()
          if (setError) throw setError
          const setId = setData.id

          if (replaceProducts) {
            setStatus({ state: 'uploading', progress: 'Clearing existing products' })
            const { error: deleteErr } = await supabase
              .from('products')
              .delete()
              .eq('set_id', setId)
            if (deleteErr) throw deleteErr
          }

          // De-dupe products by tcg_product_id and keep the latest price snapshot per product.
          const productMap = new Map<
            number,
            { row: Record<string, unknown>; priceUpdatedAt: number }
          >()
          rows.forEach((row) => {
            const productId = row.productId
            if (!productId) return
            const capturedAt = toIso(row.modifiedOn)
            const capturedTime = Date.parse(capturedAt)

            const baseRow = {
              tcg_product_id: productId,
              name: row.name,
              clean_name: row.cleanName,
              product_type: parseCardNumber(row.extNumber) === null ? 'sealed' : 'single',
              subtype: row.subTypeName,
              card_number: row.extNumber,
              rarity: row.extRarity,
              card_type: row.extCardType,
              hp: row.extHP,
              stage: row.extStage,
              attack1: row.extAttack1,
              attack2: row.extAttack2,
              weakness: row.extWeakness,
              resistance: row.extResistance,
              retreat_cost: row.extRetreatCost,
              image_url: row.imageUrl,
              image_count: row.imageCount,
              external_url: row.url,
              modified_on: row.modifiedOn || null,
              set_id: setId,
            }

            const priceRow = {
              low_price: toNumber(row.lowPrice),
              mid_price: toNumber(row.midPrice),
              high_price: toNumber(row.highPrice),
              market_price: toNumber(row.marketPrice),
              direct_low_price: toNumber(row.directLowPrice),
              currency: 'USD',
              price_updated_at: capturedAt,
              modified_on: capturedAt,
            }

            const existing = productMap.get(productId)
            if (!existing) {
              productMap.set(productId, {
                row: { ...baseRow, ...priceRow },
                priceUpdatedAt: Number.isFinite(capturedTime) ? capturedTime : 0,
              })
              return
            }

            const nextRow = { ...existing.row, ...baseRow }
            const nextTime = Number.isFinite(capturedTime) ? capturedTime : existing.priceUpdatedAt
            if (nextTime >= existing.priceUpdatedAt) {
              Object.assign(nextRow, priceRow)
              existing.priceUpdatedAt = nextTime
            }
            existing.row = nextRow
          })

          const products = Array.from(productMap.values()).map((entry) => entry.row)
          const productChunks = chunk(products, 400)

          for (let i = 0; i < productChunks.length; i++) {
            setStatus({
              state: 'uploading',
              progress: `Upserting products ${i + 1}/${productChunks.length}`,
            })
            const { error } = await supabase
              .from('products')
              .upsert(productChunks[i], { onConflict: 'tcg_product_id' })
            if (error) throw error
          }

          setStatus({
            state: 'done',
            message: `Imported ${products.length} products.`,
          })
        } catch (err) {
          setStatus({ state: 'error', message: formatError(err) || 'Upload failed' })
        }
      },
      error: (err) => setStatus({ state: 'error', message: formatError(err) }),
    })
  }

  return (
    <div className="admin-panel card-surface">
      <div className="admin-panel-head">
        <div>
          <div className="pill">CSV import</div>
          <h2>Upload TCG CSV</h2>
          <p className="swatch-note">
            Maps CSV rows to Supabase `products` with current prices. Only admin can run.
          </p>
        </div>
        <div className="admin-actions">
          <input
            type="text"
            value={tcgTypeName}
            onChange={(e) => setTcgTypeName(e.target.value)}
            placeholder="TCG type name"
          />
          <input
            type="text"
            value={setName}
            onChange={(e) => setSetName(e.target.value)}
            placeholder="Set name"
          />
          <input
            type="text"
            value={setCode}
            onChange={(e) => setSetCode(e.target.value)}
            placeholder="Set code"
          />
          <label className="toggle">
            <input
              type="checkbox"
              checked={replaceProducts}
              onChange={(e) => setReplaceProducts(e.target.checked)}
            />
            Replace products in set
          </label>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button className="btn primary" onClick={handleUpload} disabled={!file || status.state === 'uploading'}>
            {status.state === 'uploading' ? 'Uploading…' : 'Start import'}
          </button>
        </div>
      </div>
      <div className="admin-status">
        {status.state === 'idle' && <span>Choose a CSV to begin.</span>}
        {status.state === 'parsing' && <span>Parsing CSV…</span>}
        {status.state === 'uploading' && <span>{status.progress}</span>}
        {status.state === 'done' && <span className="success">{status.message}</span>}
        {status.state === 'error' && <span className="error">{status.message}</span>}
      </div>
    </div>
  )
}
