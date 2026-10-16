-- Lets a restarted server find and kill agent processes left over from a crash (invariant 9).
ALTER TABLE runs ADD COLUMN pid INTEGER;
