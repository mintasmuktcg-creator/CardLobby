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

type ProductPriceDbRow = {
  captured_at?: string | null
  market_price?: number | null
  mid_price?: number | null
  low_price?: number | null
  high_price?: number | null
  direct_low_price?: number | null
}

type ProductDbRow = {
  tcg_product_id: number | null
  set_id: string | null
  name: string
  clean_name: string | null
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
  card_sets?:
    | { id: string; name: string; code: string | null }
    | { id: string; name: string; code: string | null }[]
    | null
  product_prices?: ProductPriceDbRow[] | null
}

type CardRow = {
  productId: number
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

function isSingleCard(card: CardRow) {
  const numberParsed = parseCardNumber(card.extNumber)
  // Strict rule: a card number means this is a single; absence means sealed.
  return numberParsed !== null
}

function variantLabel(card: CardRow) {
  return (card.subTypeName || 'Other').trim() || 'Other'
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

async function upsertIndividually(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  setStatus: (s: UploadStatus) => void,
  label: string,
) {
  let processed = 0
  for (const row of rows) {
    processed += 1
    setStatus({
      state: 'uploading',
      progress: `${label} ${processed}/${rows.length}`,
    })
    const { error } = await supabase.from(table).upsert(row, { onConflict })
    if (error) throw error
  }
}

function hydrateCards(rows: CardRow[], setCardsFn?: (r: CardRow[]) => void, setVariantsFn?: (v: string[]) => void, setFiltersFn?: (s: Set<string>) => void) {
  const sorted = rows.sort((a: CardRow, b: CardRow) => {
    const aNum = parseCardNumber(a.extNumber)
    const bNum = parseCardNumber(b.extNumber)
    if (aNum !== null && bNum !== null && aNum !== bNum) {
      return aNum - bNum
    }
    return (a.name || '').localeCompare(b.name || '')
  })

  const variants = new Set<string>()
  sorted.forEach((row) => variants.add(variantLabel(row)))
  const variantList = Array.from(variants).sort((a, b) => a.localeCompare(b))

  if (setCardsFn) setCardsFn(sorted)
  if (setVariantsFn) setVariantsFn(variantList)
  if (setFiltersFn) setFiltersFn(new Set(variantList))
}

function App() {
  const [cards, setCards] = useState<CardRow[]>([])
  const [sets, setSets] = useState<SetInfo[]>([])
  const [selectedSetId, setSelectedSetId] = useState<string>('all')
  const [viewMode, setViewMode] = useState<'singles' | 'sealed' | 'all'>(
    'singles',
  )
  const [availableVariants, setAvailableVariants] = useState<string[]>([])
  const [variantFilters, setVariantFilters] = useState<Set<string>>(new Set())
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
          hydrateCards(parsed, setCards, setAvailableVariants, setVariantFilters)
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
      setAvailableVariants([])
      setVariantFilters(new Set())
      return
    }

    localStorage.setItem('cardlobby.selected_set_id', selectedSetId)

    let cancelled = false

    const loadSet = async () => {
      setLoading(true)
      setCards([])
      setAvailableVariants([])
      setVariantFilters(new Set())

      try {
        const pageSize = 1000
        let from = 0
        const all: ProductDbRow[] = []

        while (true) {
          setLoadMessage(`Loading set… (${all.length} loaded)`)

          const { data, error } = await supabase
            .from('products')
            .select(
              'id, tcg_product_id, set_id, name, clean_name, product_type, subtype, card_number, rarity, card_type, hp, stage, attack1, attack2, weakness, resistance, retreat_cost, image_url, image_count, external_url, modified_on, card_sets(id,name,code), product_prices(captured_at, market_price, mid_price, low_price, high_price, direct_low_price)',
            )
            .eq('set_id', selectedSetId)
            .order('tcg_product_id', { ascending: true })
            .order('captured_at', {
              ascending: false,
              referencedTable: 'product_prices',
            })
            .limit(1, { referencedTable: 'product_prices' })
            .range(from, from + pageSize - 1)

          if (error) throw error
          const page = Array.isArray(data) ? (data as unknown as ProductDbRow[]) : []
          if (page.length === 0) break
          all.push(...page)
          if (page.length < pageSize) break
          from += pageSize
        }

        if (cancelled) return

        const mapped: CardRow[] = all.map((row) => {
          const setEmbed = Array.isArray(row.card_sets)
            ? row.card_sets[0] ?? null
            : row.card_sets ?? null
          const latestPrice = row.product_prices?.[0] ?? null
          return {
            productId: row.tcg_product_id ?? 0,
            name: row.name,
            cleanName: row.clean_name ?? row.name,
            setId: row.set_id ?? setEmbed?.id ?? null,
            setName: setEmbed?.name ?? null,
            imageUrl: row.image_url,
            lowPrice: latestPrice?.low_price ?? null,
            midPrice: latestPrice?.mid_price ?? null,
            highPrice: latestPrice?.high_price ?? null,
            marketPrice: latestPrice?.market_price ?? null,
            directLowPrice: latestPrice?.direct_low_price ?? null,
            extNumber: row.card_number,
            extRarity: row.rarity,
            extCardType: row.card_type,
            extAttack1: row.attack1,
            extAttack2: row.attack2,
            extWeakness: row.weakness,
            extResistance: row.resistance,
            extRetreatCost: row.retreat_cost,
            extHP: row.hp,
            extStage: row.stage,
            imageCount: row.image_count,
            subTypeName: row.subtype,
            url: row.external_url,
            modifiedOn: row.modified_on,
          }
        })

        hydrateCards(mapped, setCards, setAvailableVariants, setVariantFilters)
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

      if (single) {
        const label = variantLabel(card)
        if (variantFilters.size > 0 && !variantFilters.has(label)) return false
      }

      return true
    })
  }, [cards, viewMode, variantFilters])

  const visibleCards = useMemo(() => {
    const sorted = [...filteredCards].sort((a, b) => {
      const aNum = parseCardNumber(a.extNumber)
      const bNum = parseCardNumber(b.extNumber)
      // Prioritize entries with card numbers (singles) and order ascending.
      if (aNum !== null && bNum !== null && aNum !== bNum) return aNum - bNum
      if (aNum !== null && bNum === null) return -1
      if (aNum === null && bNum !== null) return 1
      return (a.name || '').localeCompare(b.name || '')
    })
    return sorted
  }, [filteredCards])

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
              ? 'Choose a set to load its cards and sealed products.'
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
        </div>

        {availableVariants.length > 0 && (
          <div className="chip-row">
            {availableVariants.map((variant) => {
              const active = variantFilters.has(variant)
              return (
                <button
                  key={variant}
                  className={active ? 'chip active' : 'chip'}
                  onClick={() => {
                    const next = new Set(variantFilters)
                    if (active) {
                      next.delete(variant)
                    } else {
                      next.add(variant)
                    }
                    // Prevent empty filter: if we cleared all, restore all.
                    if (next.size === 0) {
                      availableVariants.forEach((v) => next.add(v))
                    }
                    setVariantFilters(next)
                  }}
                >
                  {variant}
                </button>
              )
            })}
          </div>
        )}

        <div className="cards-grid">
          {loading && <div className="card-tile loading">Loading set…</div>}
          {!loading && visibleCards.length === 0 && (
            <div className="card-tile loading">No cards found.</div>
          )}
          {visibleCards.map((card, idx) => (
            <article
              className="card-tile"
              key={`${card.productId}-${card.extNumber ?? 'na'}-${idx}`}
            >
              <div className="card-media">
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
          ))}
        </div>
      </section>

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
  const [categoryName, setCategoryName] = useState('Pokémon TCG')
  const [setName, setSetName] = useState('Mega Evolution — Ascended Heroes')
  const [setCode, setSetCode] = useState('MEA')
  const [replaceCards, setReplaceCards] = useState(false)

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

          // Upsert category
          const { data: catData, error: catError } = await supabase
            .from('categories')
            .upsert({ name: categoryName }, { onConflict: 'name' })
            .select('id')
            .single()
          if (catError) throw catError
          const categoryId = catData.id

          // Upsert set
          const { data: setData, error: setError } = await supabase
            .from('card_sets')
            .upsert(
              {
                name: setName,
                code: setCode || null,
                category_id: categoryId,
                tcg_group_id: tcgGroupId,
                tcg_category_id: tcgCategoryId,
              },
              { onConflict: 'code' },
            )
            .select('id')
            .single()
          if (setError) throw setError
          const setId = setData.id

          if (replaceCards) {
            setStatus({ state: 'uploading', progress: 'Clearing existing cards' })
            const { error: deleteErr } = await supabase
              .from('cards')
              .delete()
              .eq('set_id', setId)
            if (deleteErr) throw deleteErr
          }

          // De-dupe products by tcg_product_id to avoid ON CONFLICT hitting the same row twice
          const productMap = new Map<number, Record<string, unknown>>()
          rows.forEach((row) => {
            productMap.set(row.productId, {
              tcg_product_id: row.productId,
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
              category_id: categoryId,
              set_id: setId,
            })
          })
          const products = Array.from(productMap.values())

          const productChunks = chunk(products, 400)
          const idMap = new Map<number, string>()

          for (let i = 0; i < productChunks.length; i++) {
            setStatus({
              state: 'uploading',
              progress: `Upserting products ${i + 1}/${productChunks.length}`,
            })
            const { data, error } = await supabase
              .from('products')
              .upsert(productChunks[i], { onConflict: 'tcg_product_id' })
              .select('id, tcg_product_id')
            if (error) throw error
            data?.forEach((row) => {
              if (row.tcg_product_id) idMap.set(row.tcg_product_id, row.id)
            })
          }

          // Upsert cards for singles
          const singleRows = rows.filter((r) => parseCardNumber(r.extNumber) !== null)
          const cardMap = new Map<string, Record<string, unknown>>()
          singleRows.forEach((row) => {
            const num = row.extNumber
            if (!num) return
            const key = `${setId}-${num}`
            if (!cardMap.has(key)) {
              cardMap.set(key, {
                set_id: setId,
                name: row.name,
                number: row.extNumber,
                rarity: row.extRarity,
                supertype: row.extCardType,
                subtype: row.subTypeName,
                image_url: row.imageUrl,
              })
            }
          })

          const cards = Array.from(cardMap.values())
          const cardChunks = chunk(cards, 400)
          const cardIdMap = new Map<string, string>()
          for (let i = 0; i < cardChunks.length; i++) {
            setStatus({
              state: 'uploading',
              progress: `Upserting cards ${i + 1}/${cardChunks.length}`,
            })
            const { data, error } = await supabase
              .from('cards')
              .upsert(cardChunks[i], { onConflict: 'set_id,number' })
              .select('id, number')
            if (error) throw error
            data?.forEach((row) => {
              if (row.number) cardIdMap.set(row.number, row.id)
            })
          }

          // De-dupe prices by product_id + captured_at to avoid double-hit
          const priceKeyMap = new Map<string, Record<string, unknown>>()
          rows.forEach((row) => {
            const pid = idMap.get(row.productId)
            if (!pid) return
            const captured = row.modifiedOn || new Date().toISOString()
            const key = `${pid}|${captured}`
            if (!priceKeyMap.has(key)) {
              priceKeyMap.set(key, {
                product_id: pid,
                source: 'csv',
                currency: 'USD',
                low_price: row.lowPrice ?? null,
                mid_price: row.midPrice ?? null,
                high_price: row.highPrice ?? null,
                market_price: row.marketPrice ?? null,
                direct_low_price: row.directLowPrice ?? null,
                captured_at: captured,
              })
            }
          })
          const prices = Array.from(priceKeyMap.values())

          // Price history for cards
          type CardPriceUpsertRow = {
            card_id: string
            source: string
            currency: string
            price_cents: number
            captured_at: string
          }

          const cardPrices: CardPriceUpsertRow[] = rows
            .map((row): CardPriceUpsertRow | null => {
              const cardId = row.extNumber ? cardIdMap.get(row.extNumber) : null
              if (!cardId) return null
              const cents = Math.round((row.marketPrice ?? row.midPrice ?? row.lowPrice ?? 0) * 100)
              return {
                card_id: cardId,
                source: 'csv',
                currency: 'USD',
                price_cents: cents,
                captured_at: row.modifiedOn || new Date().toISOString(),
              }
            })
            .filter((v): v is CardPriceUpsertRow => v !== null)

          await upsertIndividually(
            'product_prices',
            prices,
            'product_id,source,captured_at',
            setStatus,
            'Upserting prices',
          )

          await upsertIndividually(
            'price_history',
            cardPrices,
            'card_id,source,captured_at',
            setStatus,
            'Upserting card price history',
          )

          setStatus({
            state: 'done',
            message: `Imported ${products.length} products, ${cards.length} cards, ${prices.length} product prices, and ${cardPrices.length} card price rows.`,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setStatus({ state: 'error', message: message || 'Upload failed' })
        }
      },
      error: (err) => setStatus({ state: 'error', message: err.message }),
    })
  }

  return (
    <div className="admin-panel card-surface">
      <div className="admin-panel-head">
        <div>
          <div className="pill">CSV import</div>
          <h2>Upload TCG CSV</h2>
          <p className="swatch-note">
            Maps CSV rows to Supabase `products` and `product_prices`. Only admin can run.
          </p>
        </div>
        <div className="admin-actions">
          <input
            type="text"
            value={categoryName}
            onChange={(e) => setCategoryName(e.target.value)}
            placeholder="Category name"
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
              checked={replaceCards}
              onChange={(e) => setReplaceCards(e.target.checked)}
            />
            Replace cards in set
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
