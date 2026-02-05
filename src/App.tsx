import './App.css'

function App() {
  return (
    <div className="page">
      <header className="eyebrow">Card Lobby</header>
      <h1 className="headline">
        A Muk-inspired home for trading card buyers, sellers, and collectors.
      </h1>
      <p className="lede">
        Sticky pricing insights, gooey-fast deck building, and collections that
        stay organized even when the market gets messy.
      </p>

      <div className="cta-row">
        <button className="btn primary">Launch Card Lobby</button>
        <button className="btn ghost">Preview deck tracker</button>
      </div>

      <section className="feature-grid">
        <article className="feature-card">
          <div className="pill">⚡ Instant setup</div>
          <h2>Import and sort</h2>
          <p>
            Drag in CSVs or lists from your favorite marketplaces; we clean and
            categorize with zero manual work.
          </p>
        </article>

        <article className="feature-card">
          <div className="pill">📈 Live pricing</div>
          <h2>Sludge-proof values</h2>
          <p>
            Auto-refresh prices so your trades are fair, whether you&apos;re in
            a lobby or at a local meet-up.
          </p>
        </article>

        <article className="feature-card">
          <div className="pill">🤝 Trading lane</div>
          <h2>Shareable lists</h2>
          <p>
            Publish wishlists and duplicates with one link; friends can counter
            with their own offers in real time.
          </p>
        </article>
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
