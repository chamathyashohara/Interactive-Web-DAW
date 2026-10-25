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

# Learning path (lessons L1-L6; internal module ids m0-m5)

The Learn view opens on the learning path from the course outline: M0 Meet the piano roll, M1 Notes, M2 Scales and
keys, M3 Chords, M4 Chord progressions, M5 Melody (all sub-lesson titles are in `curriculum.ts`). A sub-lesson follows
Hook, Watch, Try, Practice (feedback inside, with three hint levels), Quick check, Done. Only **M3 "The root note"** is
written so far; the rest are listed as planned. The four earlier lessons above stay available under "Earlier lessons"
until they are folded into modules (chords into M3/M4, melody into M5, rhythm and MIDI editing as new modules).

## L4 sub-lesson 2: The root note (`m3-root-note`, version 1)

Summary: Every chord is named after one note: its root. Learn to find it.

### Hook
- "Every chord has a boss." It is called the root note, and it gives the chord its name.
- Press Hear it: C major, root C (the chord is shown on the roll with the root marked).

### Watch (the roll draws it, with sound; captions shown)
1. A chord is several notes played at the same time. This one is made of three notes. (C E G)
2. One of them is the root. Here it is C: the chord is named after it, so this is C major. (root marked)
3. Change the root and you change the chord's name. With G as the root, we get G major. (G B D)
4. Same idea again: F is the root, so this chord is F major. (F A C)
5. Even for A minor, look at the first letter of the name: A. That is the root. (A C E)
6. So to find a chord's root, read the first letter of its name. Now you try. (C marked)

### Try (ghost notes; wrong notes turn red at once)
- Build C major on beat 1 of bar 1. Start with the root, C, then add E and G. Follow the dashed ghost notes. A red note does not belong in the chord.
- Red = any note whose pitch class is not C, E or G. Tools offered: Draw, Select, Delete (no clipboard or Quantize yet).
- Check: C, E and G heard on beat 1 of bar 1 (the existing chords check).

### Practice (blank roll, no ghost notes, same limited tools)
- Place just the root note of each chord, one note per bar on beat 1: bar 1 C major, bar 2 G major, bar 3 F major, bar 4 A minor.
- Check (`rootNotes`): in each bar exactly the root's pitch class sounds on beat 1, any octave. Feedback tells apart "B is part of G major, but it is not the root" from "F# is not even in G major", and asks for only the root if a whole chord is placed.
- Hint 1: reminder ("The root is the note a chord is named after. Read the first letter of each chord's name."). Hint 2: the four root rows are highlighted on the roll. Hint 3: the answer is shown as ghost notes.

### Quick check
- "A chord is called F minor. Which note is its root?" F / A♭ / C / E (answer F). Wrong answer: "Not quite. Think about how a chord gets its name, then try again." Right answer shows the explanation.

### Done
- The root is the note a chord is named after. / Read the first letter of the chord's name to find it: G major → G, A minor → A. / Change the root and you change the chord, even if the pattern of notes stays the same.

Questions for the reviewer:
- Is the first letter rule enough for chords such as F♯ minor or B♭ major (root F♯, B♭)? A later sub-lesson would cover sharps and flats in names.
- Should Practice also ask for the root in a low octave (bass note) to link to M4's "Rhythm and a bass note"?

# L1 (internal id m0): Meet the piano roll (all six sub-lessons, version 1)

Tools are introduced one at a time; each sub-lesson's roll only offers the tools taught so far. Full text is in
`content/m0.ts`; this is the outline for review.

| Sub-lesson | Try (ghost notes) | Practice (no ghosts) | Tools | Quick check |
|---|---|---|---|---|
| What you see | Place C4 at the start of bar 1 | C4, D4, E4 on beats 1-3 | Draw | Moving a note up makes it sound higher |
| Beats and bars (new) | A 1-beat note on beat 3 of bar 1 (the beat is highlighted) | A 2-beat note on bar 1 beat 1, a 1-beat note on bar 2 beat 4 | Draw | 4 beats in a bar |
| Play, loop, tempo | Set the tempo to 60 BPM (a pattern is given) | Tempo 140 BPM and a note on each beat of bar 1 | Draw | At the end, playback loops to the start |
| Draw and delete | Draw C4 on beats 1-4, delete beat 3 | Delete G4 on beats 2 and 4, draw E4 at bar 2 | Draw, Delete | The Delete tool removes a note |
| Move and resize | Move C4 (beat 1) to E4 on beat 3, two beats long | Fix three misplaced notes: C4 b1, E4 b2 (1 beat), G4 b3 (2 beats) | + Select | Dragging up/down changes pitch |
| Select, copy, undo | Duplicate a C-E pair onto beats 3-4 | Duplicate G-E until it fills bars 1-2 (8 notes) | + Select all, copy, paste, duplicate | Ctrl+Z undoes |
| Mini challenge (Twinkle Twinkle) | Line one: C C G G A A G | Line two on your own: F F E E D D C | all of the above | Ctrl+Z is the fastest fix |

Each has a Hook (with sound), a four-step Watch, three-level Practice hints and a recap. Note: the tempo set in
"Play, loop, tempo" stays in the learner's project (the recap says so).

# L2 (internal id m1): Notes (all six sub-lessons, version 1)

Tools: Draw, Select, Delete and the copy/duplicate strip (all taught in M0). Full text in `content/m1.ts`.

| Sub-lesson | Try (ghost notes) | Practice (no ghosts) | Quick check |
|---|---|---|---|
| High and low | A low note (≤ C3) on beat 1, a high one (≥ C5) on beat 3 | One note per zone: low, middle (C4-B4), high, low | Highest of C3/C5/C4/C2 is C5 |
| Note names A–G | C4 D4 E4 F4, then G4 at bar 2 | A, F, D, B on beats 1-4, any octave | After G comes A |
| Sharps and flats | C#4 and E♭4 | F#, B♭, G#, D♭ on beats 1-4, any octave | C# and D♭ are the same key |
| Octaves and middle C | C4, C5, C3 | G4, the G an octave up, the E an octave below E4 | An octave is 12 keys |
| Semitones and whole tones | From C4: a semitone up, a whole tone up | From E4: semitone up, whole tone up, semitone down (watch E-F) | A whole tone is 2 semitones |
| Note lengths and beats | Half note, then two quarter notes | Whole note; four eighths and a half note | 4 quarter notes in a whole note |

# L4 (internal id m3): Chords (all eight sub-lessons, version 1)

Written for complete beginners: one idea per sub-lesson, short sentences, white keys first, chords built by counting
rows (root, +4, +7 for major; root, +3, +7 for minor). Full text in `content/m3.ts` (and `m3-root-note.ts`).

| Sub-lesson | Try (ghost notes) | Practice (no ghosts) | Quick check |
|---|---|---|---|
| What a chord is | Stack C4 E4 G4 on beat 1 | Bar 1: any 3 notes together; bar 2: 3 notes one after another | Notes that start together |
| The root note | C major, root first | Only the root of C, G, F, Am | Root of F minor is F |
| Intervals | C+E (4 rows) on beat 1, C+G (7 rows) on beat 3 | Major third above D4, fifth above A3, minor third above E4 | A fifth is 7 rows |
| Major triad | G major (G B D) | C, F, D, A major | C major = C E G |
| Minor triad | Turn C major into C minor (the E starts red) | A, D, E, C minor | Lower the middle note one row |
| Reading chord names | Build "Dm" | Chart \| C \| Am \| F \| G \| | "Em" = E minor |
| Chords of a key | The white-key chord on E (E minor) | White-key chords starting on F, A, D, G | A minor belongs to C major |
| Inversions (optional) | Move C4 up an octave: E at the bottom | F/A, G/B, C/G, Am/C | E G C = C major, 1st inversion |

Feedback for chords now names the classic mix-up directly, e.g. "E♭ makes it minor: raise it one row (a semitone) to E",
and for inversions "Your lowest note is C. Make E the lowest note by moving it below the others."

# L3 (internal id m2): Scales and keys (all seven sub-lessons, version 1)

Beginner wording: scales are built by counting rows (whole step W = 2 rows, half step H = 1 row), white keys first.
Full text in `content/m2.ts`.

| Sub-lesson | Try (ghost notes) | Practice (no ghosts) | Quick check |
|---|---|---|---|
| What a scale is | C major up, C4 to C5 | C major down, C5 to C4 | A scale is notes in order to the octave |
| Major scale pattern | C major with W/H labels | From G4 with W W H W W W H (G major, F#) | The pattern is W W H W W W H |
| Major scale from any note | D major (F#, C#) | F major (B♭) | F major's black key is B♭ |
| Degrees and the key | Degrees 1, 3, 5 of C major | Degrees 1, 4, 5, 1 of G major | Degree 5 of C major is G |
| Natural minor | A minor, A3 to A4 (white keys) | E minor (F#) | A minor shares C major's notes |
| In key vs out of key | 6-note melody in C major; black keys turn red | Fix the 2 out-of-key notes in a given melody | F# is out of C major |
| Pentatonic (optional) | C pentatonic up; F and B turn red | Own 8-note melody in C D E G A, ending on C | F and B are left out |

# L5 (internal id m4): Chord progressions (all six sub-lessons, version 1)

Beginner wording: chords take turns, I is home, V is tense, Roman numerals are scale degrees (capitals major, small
letters minor). Full text in `content/m4.ts`.

| Sub-lesson | Try (ghost notes) | Practice (no ghosts) | Quick check |
|---|---|---|---|
| Chords in time | C on beat 1, G on beat 3 (two beats each) | Am, F, C, G, two beats each | The old chord stops when the new one starts |
| Home and tension | Answer G (tension) with C (home) | Finish C, F, G with the home chord | C is home in C major |
| I–V–vi–IV | C, G, Am, F | The same in G major: G, D, Em, C | I–V–vi–IV in C is C, G, Am, F |
| Other classics | I–IV–V–I: C, F, G, C | vi–IV–I–V worked out from the numbers: Am, F, C, G | I–IV–V–I in C is C, F, G, C |
| Your own progression | Choose F and G for the middle of C _ _ C | Own 4 chords from C major: start and end on C, no repeats in a row (any valid answer passes) | Ending on I sounds finished |
| Rhythm and a bass note | Chop a long C chord into hits on beats 1 and 3 | Add low root bass notes (C, then G) under given chord hits | The bass plays the root |

# L6 (internal id m5): Melody (all five sub-lessons, version 1)

Beginner wording. In the melody-over-chords lessons the chords sit low (below C4) and the melody above, so the checks only
judge notes at or above C4 as melody. Full text in `content/m5.ts`.

| Sub-lesson | Try (ghost notes) | Practice (no ghosts) | Quick check |
|---|---|---|---|
| Melody from a scale | 6+ notes in C major ending on C (red = out of key) | Own 8+ note melody in G major ending on G (any valid answer passes) | Steps sound smoothest |
| Chord tones | Chord tones on beats 1 and 3 over C and G (given low) | Same over Am and F | E is a chord tone of C major |
| Melody rhythm | C4 2 beats, D4 + E4 half beats, G4 1 beat | G4 ½, E4 ½, D4 1, C4 2 | Rhythm = when and how long |
| Motif and repetition | Duplicate a 3-note motif into bar 2 | Own motif, exact repeat, then a variation (same rhythm, one note changed) | A motif is a short repeated idea |
| Project: melody over your progression | Chord tones on beat 1 over C, G, Am, F | Full melody: 8+ white-key notes above C4, one at a time, chord tone on each beat 1, end on C | Beat 1 = a note of that bar's chord |

**The whole learning path (M0-M5, 39 sub-lessons) is now written.** The four "Earlier lessons" stay available; chords and
melody are covered by M3-M5, while the drum Rhythm and "Fix the recording" MIDI-editing lessons are not part of the outline
and remain under Earlier lessons.


# Display names, beats and bars (2026-10-21)

- Lessons are shown as **L1-L6** (formerly shown as M0-M5). Internal ids stay `m0`-`m5` (they are part of every
  sub-lesson id, saved progress and study logs), so nothing already recorded changes.
- New **L1 sub-lesson 2, "Beats and bars"** (`content/m0-beats-bars.ts`): a beat is one steady step of time, four beats
  make a bar, bars are numbered along the top, and a note's length is how many beats it covers (1, 2, 4 beats), shown
  step by step in Watch before any lesson asks for "beat 3 of bar 2" or "2 beats long".
- In every Try and Practice the ruler numbers each beat (1 2 3 4), the target bars/beats are highlighted in green on the
  roll (with the length, e.g. "2 beats"), and a "Where your notes go" picture shows each bar as four beat boxes with the
  notes drawn as long as they should last.
- In every Hook, **Hear it** now reads the Hook aloud; the musical example moved to **Play example** (the Hook texts
  were updated from "Press Hear it" to "Press Play example").

## Main Lessons page (cards)

Heading: "What would you like to learn?" Subtitle: "Choose a main lesson to start your journey. Build real skills.
Create your sound."

| Card | Description | Topics | Status |
| --- | --- | --- | --- |
| Piano | Learn the piano roll, notes, scales, chords, progressions and melody. Build your musical foundation step by step. | The L1-L6 module titles | Live: L1-L7, then 2 Special tasks |
| Kick Drums | Learn how to create, program and shape powerful kick drums for your tracks. | Kick drum basics, Sound design, Punch and attack, Layering, EQ and compression, Build your own kick | Live: K1-K4, then 1 Special task |
| Mixing | Get your tracks sounding professional. Learn balance, EQ, compression and more. | Gain staging, EQ, Compression, Reverb and delay, Automation, Final mix | Live: X1, then 1 Special task |
| Drum sequencer | Program beats on the step sequencer. | Kick basics, Hats, clap and snare, Shaping the beat | Live: S1-S3, then 1 Special task |
| DAW Features | Master the tools and workflow of your DAW. Work faster, stay organised and be more creative. | Navigation and workspace, Recording, Editing, Plug-ins and instruments, Automation, Project management | Coming soon (related: L1 What you see, MIDI editing) |
| Build the whole song | Put every part from the Special tasks together in the DAW. | Parts, arrangement, mix, export | Live: Special task M51.1 |

## Kick Drums course (six stages; practical work in the lesson's own workspace)

| Id | Lesson | Try (guided, target shown) | Practice (3 hints) | Practice check |
| --- | --- | --- | --- | --- |
| M12.1 | Meet the sound browser | Listen to a kick | Listen to a kick, a snare and a closed hat | Sounds heard include Kick, Snare, Closed Hat |
| M12.2 | Drag a sound onto the arrangement | Drag any sound onto the arrangement | Drag a kick onto bar 1 | A Kick track with a clip in bar 1 |
| M12.3 | Make a simple beat | Drag a kick onto bar 1 | One-bar beat: kick, snare, hat | Kick, Snare and Hat tracks with clips in bar 1 |
| M12.4 | Snap and the grid | Grid 1/4, snare on beat 3 | Snare on beat 2 with the 1/4 grid | A Snare clip starting on beat 2 |
| M12.5 | More layers: loops | Drag a drum loop onto bar 1 | Add a drum loop and a chord loop | At least two Loop tracks |
| M12.6 | Fit to tempo | Set 100 BPM (a 90 BPM loop is there) | 100 BPM and the loop fits | Tempo 100 and the loop's Fit on |
| M13.1 | The energy curve | Label the drop | Label intro, build-up, drop, breakdown | All four labels right |
| M13.2 | The breakdown | Delete the drums in bars 9-16 | Drums and bass out of bars 9-16 | No drums or bass in bars 9-16; chords still play |
| M13.3 | Build-up tension tools | Drop a riser on bar 15 | Snare roll in bars 15-16 and a riser under it | More, louder snare hits in bar 16 than 15, and a Riser over bars 15-16 |
| M13.4 | The pause before the drop | Delete the snares on beat 4 of bar 16 | Every track silent on beat 4 of bar 16 | Nothing sounds there; the roll is still there |
| M13.5 | The drop | An impact exactly on bar 17 | Impact, kick and bass back on bar 17 | Impact, a kick and a bass clip starting on bar 17 |
| M13.6 | Final exercise | Delete the drums in bars 1-8 | 8 bars breakdown, 8 bars build-up, drop on 17 | No drums in 1-8; roll never thins out in 9-16 and ends denser; a riser ends on bar 17; kick and bass in bar 17 |

## Drum sequencer course (step sequencer; one bar = 16 pads, beats = pads 1, 5, 9, 13)

| Id | Lesson | Try | Practice | Check | Hint if wrong |
| --- | --- | --- | --- | --- | --- |
| M14.1 | Your first kick | Click pad 1 in the Kick row | Kick on pad 1 and press Play (tick box) | Pitch 36 at tick 0 | The kick row is the top row. Click the first pad. |
| M14.2 | Four on the floor | Kicks on pads 1 and 5 | Kick on every beat: pads 1, 5, 9, 13 | Kicks exactly at 0, 960, 1920, 2880 | Names the missing beats ("No kick on beat 3 (pad 9)") |
| M14.3 | Feel the pulse | Click on, Play (tick box) | Hear the kick on the click, tap TAP (tick boxes) | Self-confirmed, K2 pattern still there | Press Click so you can hear the beat. |
| M14.4 | Kick on 1 and 3 | Remove the kick on pad 5 | Kicks on pads 1 and 9 only | Kicks only at 0 and 1920 | Beat 1 is pad 1 and beat 3 is pad 9. |
| M14.5 | Off-beat kicks | Add a kick on pad 7 | Add a kick between the beats | At least 3 kicks, one off the beat pads | Every kick is on a beat. Try one pad to the right of a beat pad. |
| M14.6 | Loud and soft kicks | Shift+click pad 1 | Accent on beat 1, others normal | Pad 1 at 127, another kick below 127 | Hold Shift and click the pad. It lights brighter. |
| M14.7 | Leave room for the snare | Snare on pad 5, kick off it | Snares on 5 and 13, no kick under them | Snare (38) at 960 and 2880, no kick there | The snare owns pads 5 and 13. Move the kick off them. |
| M14.8 | Make it four bars | Copy to all bars | Copy to all bars, then a kick on pad 16 of bar 4 | All four bars have kicks; bar 4 differs from bar 1 | Use Copy to all bars first, then open bar 4 with the bar buttons. |
| M14.9 | Loop just the kick | Press Loop | Drag the LOOP strip over two bars | A loop region at least 2 bars long | Drag in the thin LOOP strip above the numbers. |
| M14.10 | A kick that builds | Kick row, Ramp, Build up (1 bar) | The same over 4 bars | Kick velocities rise first to last by at least 40 | Click the Kick name first, so Ramp changes only the kick. |

## Song-making lessons (from the Song-Making Learning Workflow, 124 BPM, Am-F-C-G, one chord per bar)

| Id | Lesson | Course / module | Practice (the plan's activity) |
| --- | --- | --- | --- |
| M30.1 | Tour the DAW and set up the song project | Kick K1 | BPM 124, Loop on, Play (tick) |
| M31.3 | Repeat and transpose the progression | Piano L5 | 16 bars; octave up and back (tick) |
| M31.4 | Layer the chords on pads or strings | Piano L5 | Layer bars 1-16; compare (tick) |
| M32.2 | Hi-hats between the kicks | Sequencer S2 | Hats on 3, 7, 11, 15 with the kicks |
| M32.3 | Clap on every second kick | Sequencer S2 | Kick, hats and clap on 5 and 13 |
| M33.1 | Clips, tracks and sections | Kick K2 | Put the five sections in order |
| M33.2 | Build the 16-bar intro | Kick K2 | No kick in 1-8, kick in every bar 9-16 |
| M34.1 | Sweep up into the kick | Kick K2 | Sweep ends exactly on bar 9 |
| M34.2 | Down filter after the kick | Kick K2 | The pair at bar 9 |
| M36.2 | Close the section with a transition | Kick K2 | The pair at bar 33 |
| M37.1 | Strip back to two elements | Kick K3 | At most two elements, no kick, in 33-48 |
| M37.2 | Low-pass filter automation | Kick K3 | Filter at about 1000 Hz on bar 33 |
| M37.3 | Bring the kick back and build tension into the drop | Kick K3 | Filter opens 49-65, kick in 49-64, sweep ends on 65 |
| M38.4 | Arrange the drop | Kick K4 | Every element in every 8 bars of 65-96 |
| M39.1 | Fade the song out with FX and low-pass | Kick K4 | One element fewer every 4 bars (97-112), filter closing |
| M38.2 | Melody theory | Piano L6 | Chord tone on the downbeat of bar 4 |
| M38.3 | The four melody patterns | Piano L6 | A-B-A-C in bars 65-80 |
| M35.1 | Bass from the root notes | Piano L7 | One root per bar 9-16, in the bass range |
| M35.2 | Chop the bass with the piano roll chopper | Piano L7 | Bars 9-16 chopped; three settings tried (tick) |
| M36.1 | Add an arp preset | Piano L7 | Arp in bars 17-32; three presets tried (tick) |
| M40.1-M40.5 | One channel per element, Gain staging, EQ and compression, Pan, Master headroom | Mixing X1 | As in the plan (levels measured with the engine's meters) |

## Special tasks: "Moonwing's Theme" (one song, built part by part)

The Special tasks build one original song, written for these lessons: **Moonwing's Theme**, a magical theme in E minor
inspired by the feel of film-score fantasy themes (it does not copy any existing melody). 128 BPM, 32 bars = 60
seconds. Chords, one per bar: **Em - C - Am - B** (the B major chord's D#, from the harmonic minor, pulls back to Em).
Sounds: Piano (Piano preset), Strings (Violin), Melody (Pluck, celesta-like), Arp (Piano, high: a music box), Bass.

Melody (bar.beat, length in beats; C5 = middle C's octave up):

| Phrase | Bar 1 (Em) | Bar 2 (C) | Bar 3 (Am) | Bar 4 (B) |
| --- | --- | --- | --- | --- |
| A, the question | E5 1.5, D#5 0.5, E5 1, G5 1 | G5 1.5, F#5 0.5, E5 1, C5 1 | A4 1, C5 1, E5 1.5, D5 0.5 | D#5 2, F#5 1, B4 1 |
| B, the answer | E5 1, G5 1, B5 1.5, A5 0.5 | G5 1.5, E5 0.5, C5 1, E5 1 | A5 2, G5 0.5, E5 0.5, C5 1 | B4 1, D#5 1, F#5 2 |
| C, the ending | as A | as A | as A | F#5 1, D#5 1, B4 2 |

Song map: intro 1-8 (piano, strings, melody A-B), theme 9-16 (+ half-time drums, bass; melody A-C), climax 17-24
(everything + the music-box arp), outro 25-32 (one element fewer every 4 bars, a filter closing).

| Id | Card at the end of | Steps (each checked) | Apply |
| --- | --- | --- | --- |
| M50.1 | Piano | Em-C-Am-B over ghost notes; repeat to 16 bars; Strings layer; phrase A over ghost notes; melody A-B-A-C | Song · Piano, Song · Strings, Song · Melody |
| M50.2 | Piano | Bass from the chords in bars 9-16; roots only (E, C, A, B), two octaves down; chopped (1/4 or 1/8); Arp in bars 17-24 with a preset | Song · Bass, Song · Arp |
| M50.3 | Drum sequencer | Half-time kick on pads 1 and 9 only; hats on 3, 7, 11, 15; clap on 5 and 13; four bars with a kick on pad 16 of bar 4 | Song · Drums |
| M50.4 | Kick Drums | Sweep + down filter at bar 9; sweep and Impact into the climax on 17; down filter from 25 | Song · FX tracks |
| M50.5 | Mixing | Gain staging (kick about -9 dB), pan hats and arp apart, master -6 to -3 dB | Save my mix |
| M51.1 | Main page, last card "Build the whole song" | All parts there; 128 BPM and 32 bars; intro and theme (kick from bar 9); full climax 17-24; outro 25-32 with a closing filter; transitions; headroom; export (tick) | (the learner's own song) |

Applying a part also sets the song to 128 BPM.
