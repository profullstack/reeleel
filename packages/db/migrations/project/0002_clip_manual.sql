-- Clips generated from suggested moments are derived data and should be
-- replaced whenever the moments are, exactly as the moments themselves are
-- replaced on every scoring run.
--
-- They were not, and could not be. `moment_id` is ON DELETE SET NULL, and
-- re-scoring deletes every non-manual moment before regenerating — so the id
-- that clipsFromMoments used to recognise "I already made a clip for this"
-- was nulled out from under it. Every subsequent run appended a fresh copy.
-- One real project reached sixteen clips against a single moment, with three
-- identical copies of the same five seconds.
--
-- `manual` is what survives regeneration: a clip the user made or kept, rather
-- than one derived from a moment. It mirrors suggested_moments.manual, which
-- has always drawn the same line for the same reason.
ALTER TABLE clips ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;

-- Existing clips predate the flag. They are kept rather than swept away on the
-- next run: they may be in a reel the user already built, and silently
-- deleting someone's work to fix a duplication bug is the worse failure.
UPDATE clips SET manual = 1;
