-- Cash flow weeks now run Monday to Saturday (they used to start on a Saturday).
-- Move every stored week start from its Saturday to the Monday two days later. Safe to run once.
-- Keep a copy first: the lines of each week keep their amounts, only the week they belong to moves.
update public.cf_week_lines set week = week + 2 where extract(dow from week) = 6;
update public.cf_items set first_week = first_week + 2 where first_week is not null and extract(dow from first_week) = 6;
