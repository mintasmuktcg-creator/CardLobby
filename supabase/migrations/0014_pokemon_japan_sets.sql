-- Create Pokemon Japan sets table (separate from pokemon_sets).

create table if not exists public.pokemon_japan_sets (
  id uuid primary key default gen_random_uuid(),
  tcg_type_id uuid references public.tcg_types(id) on delete cascade,
  name text not null,
  code text,
  release_date date,
  created_at timestamptz not null default now(),
  tcg_group_id integer,
  tcg_category_id integer,
  series text,
  subseries text,
  total_cards integer,
  printed_total integer,
  release_year integer,
  symbol_url text,
  logo_url text,
  icon_url text,
  official_url text,
  description text,
  ptcg_api_id text,
  tcgplayer_url text,
  updated_at timestamptz not null default now(),
  generation smallint,
  abbreviation text,
  is_supplemental boolean,
  published_on timestamptz,
  modified_on timestamptz,
  unique (tcg_type_id, name),
  unique (code)
);

alter table public.pokemon_japan_sets
  drop constraint if exists pokemon_japan_sets_generation_check;
alter table public.pokemon_japan_sets
  add constraint pokemon_japan_sets_generation_check
  check (generation is null or (generation >= 1 and generation <= 9));

create index if not exists pokemon_japan_sets_group_idx
  on public.pokemon_japan_sets(tcg_group_id);
create index if not exists pokemon_japan_sets_generation_idx
  on public.pokemon_japan_sets(generation);
create index if not exists pokemon_japan_sets_release_date_idx
  on public.pokemon_japan_sets(release_date);

drop trigger if exists set_updated_at_pokemon_japan_sets on public.pokemon_japan_sets;
create trigger set_updated_at_pokemon_japan_sets
before update on public.pokemon_japan_sets
for each row execute function public.set_updated_at();

alter table public.pokemon_japan_sets enable row level security;

drop policy if exists "Public read pokemon japan sets" on public.pokemon_japan_sets;
create policy "Public read pokemon japan sets" on public.pokemon_japan_sets
  for select using (true);

drop policy if exists "Authenticated can insert pokemon japan sets" on public.pokemon_japan_sets;
create policy "Authenticated can insert pokemon japan sets" on public.pokemon_japan_sets
  for insert to authenticated with check (true);

drop policy if exists "Authenticated can update pokemon japan sets" on public.pokemon_japan_sets;
create policy "Authenticated can update pokemon japan sets" on public.pokemon_japan_sets
  for update to authenticated using (true) with check (true);
