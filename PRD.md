# Product Requirements Document — Card Lobby

## 1) Summary
- Card Lobby is a Muk-themed web app for trading card collectors to catalog sets/cards, track historical prices, and manage personal collections.
- Frontend: Vite + React + TypeScript (in progress, landing page exists).
- Backend: Supabase (Postgres + Auth + Storage); schema draft lives in `supabase/migrations/0001_cardlobby_schema.sql`.

## 2) Goals (v1)
- Allow users to sign up / sign in (Supabase Auth).
- Browse card categories and sets; view card details with image and latest price.
- Search cards quickly by name (e.g., “Muk”) with typo tolerance.
- Show historical price chart per card.
- Let authenticated users save cards to their collection (quantity, condition, notes).
- Store and serve card images from a bucket; metadata lives in Postgres.

## 3) Non-goals (for now)
- Marketplace (buy/sell transactions or payments).
- Grading service integrations.
- Live chat or real-time trades.

## 4) Users and scenarios
- Collector wants to log in and see their collection values over time.
- Trader wants to search “Muk” and pull every Muk card across sets quickly.
- New user imports a CSV of cards and confirms auto-categorized results (future).

## 5) Feature outline
- Authentication: email/password to start; add OAuth later.
- Catalog: category -> set -> card pages; list view with filters.
- Search: full-text search on card name/slug using Postgres `tsvector` + trigram.
- Pricing: `price_history` table; show latest price and chart by `captured_at`.
- Collections: add/update/remove cards with quantity and condition; user-scoped.
- Images: upload to `card-images` bucket; cards store `image_url`.

## 6) Data model (current draft)
- `categories(id, name)`
- `card_sets(id, category_id, name, code, release_date)`
- `cards(id, set_id, name, number, rarity, supertype, subtype, image_url, search_vector, slug)`
- `price_history(id, card_id, source, currency, price_cents, captured_at)`
- `user_collections(id, user_id, card_id, condition, quantity, notes, updated_at)`
- Storage bucket: `card-images` (private upload, public read).
- RLS: catalog tables are public read; collections are owner-only.

## 7) Tech stack and env
- Frontend: Vite 7, React 19, TS 5.9, ESLint. Theme: Muk palette.
- Backend: Supabase (Postgres 15/17), Auth, Storage. Optional R2 for cheaper images later.
- Env vars (Vite): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

## 8) Current status (Feb 5, 2026)
- Frontend: custom landing page done; no auth/forms yet.
- Backend: schema migration file added; Supabase project not yet linked/pushed.
- Git: repository initialized; build passes (`npm run build`).

## 9) Risks / open questions
- Where will source images originate (user uploads vs external APIs)?
- Pricing data source and update cadence (cron/edge function not designed yet).
- CSV import workflow not implemented; needs parsing + deduping plan.

## 10) Next steps
- Link Supabase project and run `npx supabase db push`.
- Add Supabase client and auth UI flow; gate collection mutations.
- Implement catalog and search screens backed by `cards` table.
- Add price chart component reading `price_history`.
- Wire image upload to `card-images` bucket with URL save to `cards`.

## 11) Longer-term vision (not in v1)
- First-party store: owner-managed catalog visible only to the owner in admin UI; products purchasable by logged-in users.
- Checkout flow with payments (Stripe, Braintree, or PayPal) and order management (cart, shipping, tax).
- Inventory/fulfillment: stock counts per product/variant, order statuses, and basic shipping labels.
- Roles/permissions: admin vs buyer; store admin screens gated to owner account only.
- Anti-fraud and audit logs for orders/refunds.
