-- Store Pokemon TCG "generation" for each set (1-9).
-- We keep this as a normal column (not generated) because external sources often disagree on
-- "release_date" for legacy sets and TCGplayer group publish dates are NOT reliable for this.

alter table if exists public.card_sets
  add column if not exists generation smallint;

comment on column public.card_sets.generation is
  'Pokemon TCG generation (1-9). NULL means unknown / not classified / not Pokemon.';

alter table public.card_sets
  drop constraint if exists card_sets_generation_check;
alter table public.card_sets
  add constraint card_sets_generation_check
  check (generation is null or (generation >= 1 and generation <= 9));

create index if not exists card_sets_generation_idx on public.card_sets(generation);
create index if not exists card_sets_release_date_idx on public.card_sets(release_date);
