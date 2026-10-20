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

## Lesson 2: Melody (`melody-1`, version 1)

Summary: Write a short tune that stays in the key of C major and ends on its home note.

### Step 1: What is a melody?
- A melody is the tune you could hum: a line of single notes, one after another, each with its own length.
- Melodies are built from a key: a small set of notes that sound good together. The key of C major uses just seven notes: C, D, E, F, G, A and B. On the piano roll these are the white keys.

### Step 2: Steps, leaps and the home note
- Most tunes move mostly by steps (to a neighbouring note) with an occasional leap (skipping a note or two). That is what makes a melody easy to sing.
- The first note of the key, here C, is the home note. Ending a melody on it makes the tune sound finished, like the end of a sentence.
- Notes from outside the key (the black keys, in C major) can sound wrong to a beginner's ear, so for now stay on the white keys.

### Step 3: Exercise, write a melody in C major
- Goal: Add notes to the 2-bar clip to make a melody of at least 8 notes. Use only white keys, play one note at a time, and end on a C.
- Starting state: a 2-bar synth clip with a single C4 on beat 1.
- Check: at least 8 unmuted notes; every note's pitch class is in C major; no two notes sound together; the last note is a C (any octave). Score = in-key notes ÷ max(notes, 8): it measures note accuracy, so a rule such as "end on C" can fail while the score is 1.
- Hints: (1) only white keys; (2) move mostly by small steps, add a leap now and then; (3) make each note end before the next, finish with a C in bar 2.

## Lesson 3: Rhythm (`rhythm-1`, version 1)

Summary: Program a basic drum beat: kick, snare and hi-hat in one bar.

### Step 1: Beats and bars
- Music is organised in bars, and most pop and dance music has four beats in every bar. Count them out loud: 1, 2, 3, 4.
- Between the beats are the offbeats. Counting eighth notes, you say: 1 and 2 and 3 and 4 and.

### Step 2: The basic beat
- A drum beat layers three sounds. The kick (bass drum) gives the pulse, the snare gives the backbeat, and the closed hi-hat keeps time.
- The classic pattern: kick on every beat (1, 2, 3, 4), snare on beats 2 and 4, and closed hi-hat on every eighth note.
- Press Play: the clip loops, so you can hear whether it grooves.

### Step 3: Exercise, program the beat
- Goal: Fill the empty 1-bar drum clip: Kick on beats 1, 2, 3 and 4. Snare on beats 2 and 4. Closed Hat on all eight eighth notes.
- Starting state: an empty 1-bar clip on a drum track.
- Check: kick (pitch 36) at 0, 960, 1920, 2880; snare (38) at 960, 2880; closed hat (42) every 480 ticks. A hit counts if it starts within 60 ticks of the target; extra hits on these three drums fail; other drums and muted notes are ignored. Score = hits found ÷ (hits required + extra hits).
- Hints: (1) find the Kick, Snare and Closed Hat rows, keep Snap on; (2) set the grid to 1/8, the kick only needs every second line; (3) kick 1-2-3-4, snare 2 and 4, hat on every line; try the Paint tool.

## Lesson 4: MIDI editing (`midi-editing-1`, version 1)

Summary: Clean up a played-in melody: fix timing, length, loudness and a doubled note.

### Step 1: What is MIDI?
- MIDI does not record sound. It records which notes you played: the pitch, when each one started, how long it lasted, and how hard you hit it (the velocity).
- Because it is just data, every note can be edited after you play it: moved, stretched, made louder or quieter, or deleted.

### Step 2: The four common fixes
- Timing: notes played slightly early or late can be pulled onto the beat with Quantize. Choose the grid size first (1/4 snaps to beats), then press Quantize.
- Length: drag the right edge of a note to shorten or lengthen it.
- Loudness: the velocity lane under the notes shows one bar per note. Drag a bar to make that note louder or quieter.
- Clean-up: a note played twice sits exactly on top of itself. Select it and press Delete to remove the extra one.

### Step 3: Exercise, fix the recording
- Goal: This 2-bar melody was played in by hand and has four mistakes: one note is off the beat, one is too long, one is too loud, and one is doubled. Fix all four.
- Starting state: C4, E4 (100 ticks late), G4 (three beats long, should be one), E4, F4, A4 (velocity 127), G4 twice.
- Target: C4 E4 G4 E4 (one beat each, bar 1), then F4 and A4 (one beat each, bar 2 beats 1-2) and G4 (two beats, bar 2 beats 3-4).
- Check: each target note matched by pitch, start within 30 ticks and length within 60 ticks; every note's velocity between 60 and 110; no missing, extra or doubled notes. Feedback names the first problem in the order timing, length, loudness, clean-up. Score = notes that are right (matched and in the velocity range) ÷ max(target notes, notes present).
- Hints: (1) play and listen first; (2) 1/4 grid, Quantize the late note, drag the long note's edge; (3) velocity lane for the loud note, Delete for the doubled one.

Questions for the reviewer:
- Is the target tune in lesson 4 simple enough to hear what is wrong?
- Is "eight notes minimum" right for lesson 2, or should it be shorter for first-time users?

## Added in version 2 of every lesson (Learn view)

Each explain step may carry a "Try it" call-out and short Tips, and each lesson has a "What you learned" recap for the
Summary tab. The text lives in `content/*.ts`; the recap lines are:

- Chords: A triad is three notes a third apart: root, third and fifth. / Inversions and octaves don't change which chord it is. / In C major, C – G – Am – F (I – V – vi – IV) is a progression used in countless songs.
- Melody: A melody is a line of single notes, one at a time. / The key of C major uses only the white keys: C, D, E, F, G, A, B. / Moving by steps sounds smooth; ending on the home note (C) sounds finished.
- Rhythm: Most pop music has four beats in a bar, with offbeats in between. / Kick on every beat gives the pulse; snare on 2 and 4 gives the backbeat. / Hi-hats on every eighth note keep the time steady.
- MIDI editing: MIDI stores notes, not sound, so every note can be fixed after it is played. / Quantize pulls notes onto the grid; dragging a note's edge changes its length. / The velocity lane controls how loud each note is; Delete removes doubled notes.

For the reviewer: please read the Try it and Tips lines in the app (or in `content/*.ts`) as well.
