# Lesson content (for review)

Readable copy of the lessons in `apps/desktop/src/renderer/src/features/lessons/content/`. The TypeScript files are the
source of truth; keep this file in sync so a music lecturer or producer can review wording and theory without reading
code. Bump the lesson's `version` whenever the text or the check changes.

## Lesson 1: Chords (`chords-1`, version 1)

Summary: Build the four chords of the most common pop progression: C – G – Am – F.

### Step 1: What is a chord?
- A chord is several notes played at the same time. The most common chord is a triad: three notes stacked a third apart.
- To build a triad on the piano roll, start on a note (the root), skip one white key and take the next, then skip one more and take the next. From C that gives C, E and G: a C major chord.
- The notes can be in any order or octave: E-G-C is still a C major chord (an inversion).

### Step 2: Chords in a key
- Songs move between a few chords from the same key. In the key of C major, four chords appear in thousands of pop songs:
- C major (C-E-G), G major (G-B-D), A minor (A-C-E) and F major (F-A-C). Musicians call this progression I – V – vi – IV.
- Each chord usually lasts one bar. Press Play to hear how it moves away from C and comes back.

### Step 3: Exercise, build I – V – vi – IV
- Goal: Bar 1 already has C major. Put G major in bar 2, A minor in bar 3 and F major in bar 4, each starting on beat 1.
- Starting state: a 4-bar synth clip with C4, E4, G4 held for all of bar 1.
- Check: for each bar, the pitch classes heard on beat 1 must be exactly the chord's (inversions and octave doublings accepted, extra notes not, muted notes ignored). Score = correct bars ÷ 4.
- Hints, in order:
  1. Look at bar 1: C, then skip a white key to E, then skip another to G. Build the other chords the same way from their own root.
  2. G major is G-B-D, A minor is A-C-E, F major is F-A-C. Use only white keys.
  3. Select the three notes in bar 1, copy and paste them, then drag the copy to bar 2 and move each note up or down to the new chord.

Questions for the reviewer:
- Is "skip a white key" the right beginner wording, given A minor and F major are also white-key chords here?
- Is one exercise per lesson enough practice for the pre/post-test comparison?
