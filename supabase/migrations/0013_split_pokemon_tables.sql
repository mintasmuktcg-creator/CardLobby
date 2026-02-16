-- Split Pokemon catalog into its own tables.

do $$
begin
  if to_regclass('public.card_sets') is not null
     and to_regclass('public.pokemon_sets') is null then
    alter table public.card_sets rename to pokemon_sets;
  end if;

  if to_regclass('public.products') is not null
     and to_regclass('public.pokemon_products') is null then
    alter table public.products rename to pokemon_products;
  end if;
end $$;
