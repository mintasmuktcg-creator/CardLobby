-- Ensure pokemon_sets.tcg_type_id aligns with region (EN vs JP).

do $$
declare
  pokemon_id uuid;
  japan_id uuid;
begin
  select id
    into pokemon_id
    from public.tcg_types
   where lower(coalesce(slug, '')) in ('pokemon', 'pokemon-tcg')
      or lower(name) in ('pokemon tcg', 'pokemon')
   order by
     case
       when lower(name) = 'pokemon tcg' then 0
       when lower(name) = 'pokemon' then 1
       else 2
     end
   limit 1;

  select id
    into japan_id
    from public.tcg_types
   where lower(coalesce(slug, '')) in ('pokemon-japan', 'pokemon_japan', 'pokemon-jp')
      or (lower(name) like '%pokemon%' and lower(name) like '%japan%')
   order by
     case
       when lower(name) = 'pokemon japan' then 0
       else 1
     end
   limit 1;

  if pokemon_id is not null then
    update public.pokemon_sets
       set tcg_type_id = pokemon_id
     where region = 'EN'
       and (tcg_type_id is distinct from pokemon_id);
  end if;

  if japan_id is not null then
    update public.pokemon_sets
       set tcg_type_id = japan_id
     where region = 'JP'
       and (tcg_type_id is distinct from japan_id);
  end if;
end $$;
