-- Card Lobby initial schema
-- Run via Supabase SQL editor or `supabase db push`

-- Extensions for UUIDs and search
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- Categories (e.g., Pokemon, MTG, etc.)
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- Sets (per category)
create table if not exists public.card_sets (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories(id) on delete cascade,
  name text not null,
  code text,
  release_date date,
  created_at timestamptz not null default now(),
  unique (category_id, name),
  unique (code)
);

-- Individual cards
create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  set_id uuid references public.card_sets(id) on delete cascade,
  name text not null,
  number text,
  rarity text,
  supertype text,
  subtype text,
  image_url text,
  slug text generated always as (lower(regexp_replace(name, '\s+', '-', 'g'))) stored,
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(rarity, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(lower(regexp_replace(name, '\s+', '-', 'g')), '')), 'C')
  ) stored,
  created_at timestamptz not null default now(),
  unique (set_id, number),
  unique (set_id, name)
);
create index if not exists cards_search_idx on public.cards using gin (search_vector);
create index if not exists cards_name_trgm on public.cards using gin (name gin_trgm_ops);

-- Historical pricing
create table if not exists public.price_history (
  id bigserial primary key,
  card_id uuid references public.cards(id) on delete cascade,
  source text,
  currency text default 'USD',
  price_cents integer not null,
  captured_at timestamptz not null default now(),
  constraint price_history_unique unique (card_id, source, captured_at)
);
create index if not exists price_history_card_time_idx on public.price_history (card_id, captured_at desc);

-- User collections (per authenticated user)
create table if not exists public.user_collections (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  card_id uuid references public.cards(id) on delete cascade,
  condition text default 'ungraded',
  quantity integer not null default 1,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, card_id, condition)
);
create index if not exists user_collections_user_idx on public.user_collections (user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at_user_collections on public.user_collections;
create trigger set_updated_at_user_collections
before update on public.user_collections
for each row execute function public.set_updated_at();

-- Enable Row Level Security
alter table public.categories enable row level security;
alter table public.card_sets enable row level security;
alter table public.cards enable row level security;
alter table public.price_history enable row level security;
alter table public.user_collections enable row level security;

-- storage.objects is owned by the storage schema; in hosted Supabase RLS is already enabled.
-- Attempt to enable, but skip if lacking ownership to avoid migration failure.
do $$
begin
  begin
    alter table storage.objects enable row level security;
  exception
    when insufficient_privilege then
      raise notice 'Skipped enabling RLS on storage.objects (not owner); likely already enforced by Supabase.';
  end;
end;
$$;

-- Open reads for catalog and pricing
drop policy if exists "Public read categories" on public.categories;
create policy "Public read categories" on public.categories
  for select using (true);

drop policy if exists "Public read sets" on public.card_sets;
create policy "Public read sets" on public.card_sets
  for select using (true);

drop policy if exists "Public read cards" on public.cards;
create policy "Public read cards" on public.cards
  for select using (true);

drop policy if exists "Public read prices" on public.price_history;
create policy "Public read prices" on public.price_history
  for select using (true);

-- Collections: owner-only access
drop policy if exists "Users manage their collections" on public.user_collections;
create policy "Users manage their collections" on public.user_collections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit)
values ('card-images', 'card-images', false, 5242880)
on conflict (id) do nothing;

-- Storage policies
drop policy if exists "Anyone can view card images" on storage.objects;
create policy "Anyone can view card images" on storage.objects
  for select using (bucket_id = 'card-images');

drop policy if exists "Authenticated can upload card images" on storage.objects;
create policy "Authenticated can upload card images" on storage.objects
  for insert with check (bucket_id = 'card-images' and auth.role() = 'authenticated');

drop policy if exists "Owners can update card images" on storage.objects;
create policy "Owners can update card images" on storage.objects
  for update using (bucket_id = 'card-images' and owner = auth.uid())
  with check (bucket_id = 'card-images' and owner = auth.uid());

drop policy if exists "Owners can delete card images" on storage.objects;
create policy "Owners can delete card images" on storage.objects
  for delete using (bucket_id = 'card-images' and owner = auth.uid());
