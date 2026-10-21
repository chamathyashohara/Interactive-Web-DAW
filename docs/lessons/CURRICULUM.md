# Lesson series: from "what is a note?" to a finished song

Owner: Component 1 (Interactive Music Learning Module). Status: design, ready to build.
Companion file: [`LESSON-FORMAT.md`](LESSON-FORMAT.md) (data format, check types, worked examples).

The learning interface is **separate from the DAW** (its own screen, its own simplified piano roll). Each lesson teaches one idea,
then sends the learner to the DAW to use it. This document is the content; the UI is up to the learning interface design.

---

## 1. The learning workflow (every sub-lesson follows the same loop)

```
 HOOK ──► WATCH ──► TRY (guided) ──► PRACTICE (blank roll) ──► FEEDBACK ──► QUICK CHECK ──► DONE
 why it    the roll     ghost notes    learner builds it         right/wrong    1-3 questions   summary +
 matters   draws it     show the way   alone                     + hints                         "use it in the DAW"
 (15 s)    and plays it
```

| Stage | What the learner sees | Rules |
|---|---|---|
| **Hook** | One sentence + a sound ("this is a major chord"). | Under 20 seconds of reading. |
| **Watch** | The piano roll **draws the notes or chord itself**, one step at a time, with sound and a caption ("C is the root"). Replay and slow-down buttons. | Learner cannot edit. Roots, intervals and scale degrees are labelled on the notes. |
| **Try** | Same roll, but the learner places the notes while **ghost notes / highlighted rows** show where they go. | Hints are visible. Wrong notes turn red immediately. |
| **Practice** | A **blank piano roll**, a task, no ghosts. A restricted range (e.g. only C3-C5) and only the tools taught so far. | Learner presses **Check**. |
| **Feedback** | Green = right. Red = wrong, with a **specific reason** ("E is the 3rd of C major; you placed E-flat, which makes it minor"). | 3 hint tiers, see section 3. Unlimited retries; every attempt and hint is recorded for the evaluation. |
| **Quick check** | 1-3 multiple-choice / "click the root note" questions. | Pass mark 2 of 3 (1 of 1 for a single question). |
| **Done** | One-line summary + a short **"Use it in the DAW"** task (opens the DAW with a prepared project). | Completion event is published (see `LESSON-FORMAT.md`). |

**Order of the whole series:** training on the tool first (Module 0), then theory (Modules 1-5), then rhythm (6), then production features (7-10),
ending with **making a complete song** (11).

**Naming:** modules are `M0..M11`; sub-lessons are `M3.4` (module 3, sub-lesson 4). Use these ids everywhere (data, events, unlocks).

---

## 2. Series overview

| Module | Main lesson | Sub-lessons | What the learner can do afterwards |
|---|---|---|---|
| **M0** | Meet the piano roll *(training)* | 6 | Draw, hear, move, resize, delete, select, copy and undo notes; loop and tempo. |
| **M1** | Notes | 6 | Name any key, find C4, tell sharps from flats, count semitones, place notes by name, read note lengths. |
| **M2** | Scales and keys | 6 | Build a major and a natural-minor scale from any note, name the key, stay "in key". |
| **M3** | Chords | 7 | Say what a chord is, find its **root**, build major and minor triads on any root, name chords, find the chords of a key. |
| **M4** | Chord progressions | 6 | Build and play 4-chord loops (I-V-vi-IV etc.) in any key, with a bass root note. |
| **M5** | Melody | 5 | Write a 4-bar melody over a chord progression. |
| **M6** | Rhythm and drums | 5 | Understand beats, bars and tempo; build a drum loop with kick, snare, hats. |
| **M7** | Bass and layering *(DAW)* | 4 | Add a bass track and make parts fit together. |
| **M8** | Arranging a song *(DAW)* | 5 | Use clips, song length and sections (intro, verse, chorus). |
| **M9** | Mixing basics *(DAW)* | 5 | Balance volume and pan, use mute/solo, watch the meters. |
| **M10** | Finish and share *(DAW)* | 3 | Check the loop, set the song length, export a WAV. |
| **M11** | Capstone: make your first song | 4 | Combine everything into a complete song. |

Modules M0-M6 are specified in full below. M7-M11 are outlined (same loop; details to be written when M0-M6 are built).

---

## 3. Feedback system (applies to every Practice)

* **Live nudge (Try stage only):** an out-of-place note turns red the moment it is placed (same idea as the DAW's out-of-key feedback).
* **On Check (Practice stage):** the checker returns `{ passed, score, mistakes[] }`. Each mistake has a **code** and a **plain-English message** written in the lesson file.
* **Hint tiers** (the learner asks for the next tier, or it appears after 2 failed checks):
  1. **Reminder:** the rule in words ("A major chord is the root, then 4 semitones up, then 3 more").
  2. **Highlight:** the correct rows are highlighted on the keyboard (not placed as notes).
  3. **Show me:** ghost notes appear; the learner copies them in. Counted as "hint tier 3".
* **Mastery** per sub-lesson: `mastered` (passed first try, no tier-3 hint), `passed` (passed with hints), `not yet`.
* **Never** just say "wrong". Always say *what* is wrong and *what to look at*.
* Record per exercise (local, anonymous, for the evaluation): attempts, time to first pass, hint tiers used, mistake codes. See `LESSON-FORMAT.md`.

---

## 4. Music facts used in the series (checked; use these as the source of truth)

* Middle C is **C4 = MIDI 60**. The piano roll labels C4 for pitch 60. `pitch class = pitch mod 12`: C=0, C#/Db=1, D=2, D#/Eb=3, E=4, F=5, F#/Gb=6, G=7, G#/Ab=8, A=9, A#/Bb=10, B=11.
* A **semitone** is one key (one row) up or down; a **whole tone** is 2 semitones.
* **Major scale** = W W H W W W H. C major: C D E F G A B. G major has F#. F major has Bb. D major has F# and C#.
* **Natural minor** = W H W W H W W. A minor: A B C D E F G (same notes as C major). The **relative minor** starts on the 6th note of the major scale.
* **Triads** (from the root, in semitones): major 0-4-7, minor 0-3-7, diminished 0-3-6, augmented 0-4-8. C major = C E G, C minor = C Eb G, A minor = A C E.
* **Chords of C major** (stack thirds on each scale note): I C, ii Dm, iii Em, IV F, V G, vi Am, vii° Bdim.
* **Intervals** by semitones: 1 minor 2nd, 2 major 2nd, 3 minor 3rd, 4 major 3rd, 5 perfect 4th, 6 tritone, 7 perfect 5th, 8 minor 6th, 9 major 6th, 10 minor 7th, 11 major 7th, 12 octave.
* **Common progressions** (in C): I-V-vi-IV = C G Am F. I-vi-IV-V = C Am F G. ii-V-I = Dm G C. vi-IV-I-V = Am F C G.
* **Rhythm:** 4/4 = four beats per bar; quarter note = 1 beat (960 ticks), eighth = 480, sixteenth = 240. The DAW's drum rows: kick 36, snare 38, clap 39, closed hat 42, open hat 46.

---

## 5. Module M0 - Meet the piano roll *(training; no theory yet)*

Goal: before any music theory, the learner can use the tool. Each sub-lesson ends with a **Practice** that only needs the tools taught so far.

| Id | Sub-lesson | Watch / Teach | Practice (blank roll) | Check | Typical mistake -> feedback |
|---|---|---|---|---|---|
| **M0.1** | What you are looking at | Labels slide in: **up = higher sound, down = lower; left to right = time**; the keyboard on the left; the grid; bar numbers; the playhead. | Click the keyboard keys: "find the lowest key and the highest key shown", "click a key that sounds higher than the last one". | Event check: key clicks heard (`keyPressed` events); question about up/down. | Picks wrong direction -> "Higher sounds are *higher up* on the roll." |
| **M0.2** | Hear it: play, loop, tempo | The roll plays a 2-bar pattern; the playhead moves; loop on/off; tempo 80 vs 140. | Press Play; change the tempo to 100 BPM; turn loop on. | State check: tempo = 100 (+/-1), loop enabled, playback started. | Tempo not changed -> "Type 100 in the BPM box and press Enter." |
| **M0.3** | Draw and delete a note | Draw tool places a note where you click; a note has a **pitch (row)** and a **start (column)**; Delete tool / right-click removes it. | "Draw three notes in bar 1", then "delete the middle one". | Final state: exactly 2 notes in bar 1; `opSeen: addNote x3, deleteNote x1`. | Drew 4 notes -> "You have 4 notes; the task needs 3 first, then delete one." |
| **M0.4** | Move and resize | Select tool: drag a note sideways (**changes when it plays**), up/down (**changes the pitch**), drag its right edge (**changes how long it lasts**). Snap and grid size. | A note is given at C4 on beat 1. "Move it up to E4", "make it last 2 beats", "move it to beat 3". | State check on that note: pitch 64, duration 1920 ticks, start 1920 ticks. | Moved wrong way -> "Dragging up raises the pitch (higher sound)." |
| **M0.5** | Select, copy, paste, undo | Box-select several notes; Ctrl+C / Ctrl+V; Ctrl+Z; Duplicate. | A 4-note pattern is shown. "Select all four, copy, paste in bar 2." Then "undo the paste, redo it". | State: 8 notes, second group = first group + 1 bar; `opSeen: undo, redo`. | Pasted at the same place -> "Click the ruler to move the playhead to bar 2 first; paste goes at the playhead." |
| **M0.6** | Mini challenge: Twinkle, Twinkle | Watch the roll draw the first phrase (C C G G A A G); play it. | Draw it from memory with the hint available: C4 C4 G4 G4 A4 A4 G4, each one beat, G4 two beats. | Exact note sequence (pitches and starts); length +/-10%. | Wrong pitch -> red note + "Compare with the Watch step: this note should be higher/lower." |

Unlocks in the DAW after M0: the piano-roll basics (Draw, Select, Delete, Undo, Play/Loop, Tempo). Advanced tools (Paint, Slice, Quantize) unlock later (see section 10).

---

## 6. Module M1 - Notes

| Id | Sub-lesson | Watch / Teach | Practice | Check | Feedback |
|---|---|---|---|---|---|
| **M1.1** | High and low: pitch | Two notes; the higher row sounds higher. "Pitch = how high or low." | Place a note that is **higher** than a given note, then one **lower**. | Compare pitches of placed notes to the given one. | "That note is lower. Go up the roll." |
| **M1.2** | The note names A to G | The white keys repeat A B C D E F G. Finding **C**: it is the white key just left of **two** black keys. Labels appear on the roll. | "Place a note on every C you can see", then "Place C, D, E, F, G in order, one per beat." | Pitch classes == the requested ones; order by start. | "That is B (one key left of C)." Name the note actually placed. |
| **M1.3** | Black keys: sharps and flats | **#** = one key up, **b** = one key down. The same black key has two names (C# = Db). | "Place F#", "Place Bb", "Place the key that is both G# and Ab." | Pitch class check: 6, 10, 8. | Flat/sharp mix-up -> "Sharp goes *up*; you went down." |
| **M1.4** | Octaves and middle C | The same note name repeats every **12 keys** (octave). **C4 = middle C = 60**, C5 is one octave higher. Octave number shows on the roll. | "Place C4 and C5", "Place A3 and A5", "Which of these two Cs is higher?" | Pitches 60 & 72 etc. | "Same note name, different octave; count 12 keys up." |
| **M1.5** | Semitones and whole tones | Each row is a semitone; a whole tone = 2 rows. Start on C4: up 1 = C#4, up 2 = D4. | "From E4 go up a whole tone", "From B4 go down a semitone", "Which is farther: C-D or E-F?" (C-D is 2 semitones; E-F is 1). | Pitch arithmetic. | "E to F is only one row. There is no black key between them." |
| **M1.6** | Note lengths and beats | A bar has 4 beats. Whole = 4 beats, half = 2, quarter = 1, eighth = 1/2. Notes drawn at each length, with the beat counter 1-2-3-4. | "Draw one quarter, one half and one whole note in bar 1" (a whole note fills a bar). "Draw 8 eighth notes in one bar." | Durations in ticks: 960 / 1920 / 3840 / 480. | "That note lasts 3 beats; a half note lasts 2." |

Unlocks after M1: note-name display option, grid-size selector.

---

## 7. Module M2 - Scales and keys

| Id | Sub-lesson | Watch / Teach | Practice | Check | Feedback |
|---|---|---|---|---|---|
| **M2.1** | What is a scale? | A scale is a **ladder of notes that sound good together**. C D E F G A B C: play up and down. | "Play the C major scale by clicking the keys in order." | Key-press sequence. | "You skipped a note; every white key from C to C." |
| **M2.2** | The major scale pattern | Steps between notes: **W W H W W W H** (whole, whole, half...). Shown as arrows above the notes. Why C major is all white keys (E-F and B-C are the half steps). | "Build the C major scale on the roll, one note per beat, ascending." | `notesInScale`: exactly C D E F G A B C in order. | "After E the next step is a *half* step. Look: E to F." |
| **M2.3** | Major scale from any note | Apply the pattern from **G**: G A B C D E **F#** G. From **F**: F G A **Bb** C D E F. Why a sharp or flat is needed to keep the pattern. | "Build G major", then "Build F major." | Pitch-class sets {7,9,11,0,2,4,6} and {5,7,9,10,0,2,4} in order. | "G major needs F-sharp, not F: the last step before G must be a half step." |
| **M2.4** | Degrees and the key | Number the notes 1-7. The first note is the **root / tonic** (home). "Key of C major" = a song that uses these notes and feels at home on C. Do-re-mi. | "Click the 5th note of G major" (D). "Which note is the 3rd of C major?" (E). | Degree arithmetic. | "Count from the root: 1 = G, 2 = A, 3 = B, 4 = C, 5 = D." |
| **M2.5** | The natural minor scale | Pattern **W H W W H W W**. A minor = A B C D E F G (same keys as C major, different home). Sound: sadder. **Relative minor** = starts on the 6th degree of the major scale. | "Build A minor", "Build E minor (it has F#)", then "Which minor key shares the notes of C major?" | Pitch-class sets {9,11,0,2,4,5,7} and {4,6,7,9,11,0,2}. | "In minor the 3rd is *lower*: A to C is 3 semitones, not 4." |
| **M2.6** | In key or out of key | Choose a key; the roll **highlights the 7 notes of the scale** and greys the rest. A tune using only highlighted notes sounds "right"; one wrong note sounds off. | "Here is a 4-note melody in C major with one wrong note: find and fix it." Then "Write a 4-note tune using only the highlighted notes." | `notesInScale`: every note's pitch class is in the scale; the wrong note is found. | Names the offending note: "F# is not in C major. Use F or G." |
| **M2.7** *(optional)* | Pentatonic shortcut | Five-note scale; C major pentatonic = C D E G A; A minor pentatonic = A C D E G. Hard to hit a wrong note. | "Improvise a 4-bar tune using only the pentatonic notes." | Notes subset check. | "That note is outside the 5; try one of the highlighted." |

Unlocks after M2: **key and scale highlighting** in the DAW piano roll (the out-of-key red feedback is part of the adaptive layer).

---

## 8. Module M3 - Chords *(root note, building and naming)*

| Id | Sub-lesson | Watch / Teach | Practice | Check | Feedback |
|---|---|---|---|---|---|
| **M3.1** | What is a chord? | Melody = notes one after another; **chord = 3 or more notes at the same time**. The roll draws C then E then G, then stacks them. | "Play C, E and G at the same time" (stack them in one column). | 3 notes with the same start tick. | "These start at different times. Put them in the same column." |
| **M3.2** | The root note | The **root** is the note the chord is **built on and named after**. In root position it is the **lowest note**. The roll marks the root in a different colour. Examples: C-E-G root C; F-A-C root F. | "Click the root of this chord" (several chords shown). "Place a chord whose root is G." | Click on the lowest / named note; chord's lowest pitch class = G. | "The root is the note the chord is named after; here that is the lowest note." |
| **M3.3** | Intervals: counting the distance | Interval = distance between two notes, in semitones: **3 = minor 3rd, 4 = major 3rd, 7 = perfect 5th**. Counting rows from the root. | "From C, place the note 4 semitones above." "From D, place a perfect 5th (7)." | Pitch difference. | "Count rows up from the root: you went 5, the task needs 7." |
| **M3.4** | The major triad | **Major triad = root + 4 + 3** (notes at 0, 4, 7 semitones). Bright, happy. Built on C (C E G), F (F A C), G (G B D). Watch the roll draw each with the interval labels. | "Build a C major chord", "Build G major", "Build D major (it has F#)", "Build Eb major". | `pitchClassSet`: root R, R+4, R+7; 3 notes; simultaneous; any octave. | "The middle note should be 4 above the root. You placed 3 (that makes it minor)." |
| **M3.5** | The minor triad | **Minor triad = root + 3 + 4** (0, 3, 7). The **only** difference from major is the middle note, one semitone lower. Sad. Compare C vs Cm by lowering the middle note. | "Turn this C major into C minor", "Build A minor", "Build D minor", then "Is this chord major or minor?" (listen + look). | Pitch-class sets (0,3,7). Identify major vs minor. | "To make it minor, move the *middle* note down one row." |
| **M3.6** | Reading and writing chord names | **C** = C major, **Cm** (or C-) = C minor, **F#m**, **Bb**. The letter = the root; "m" = minor. | "Build Am", "Build F", "Build Gm", "Build C#m". Quiz: "Which name matches these notes?" | Chord symbol parser -> expected pitch-class set. | "The letter tells you the root (F), the 'm' tells you minor." |
| **M3.7** | The chords of a key | Stack **every other** scale note (3rds) on each degree of C major: C, **Dm**, **Em**, F, G, **Am**, **Bdim**. Chord numbers **I ii iii IV V vi vii°** (capital = major, small = minor). The roll builds all seven. | "Build the IV chord in C major (F A C)", "Build the vi chord (Am)", "Build the V chord in G major (D F# A)". | Chord = degree-based pitch classes of the key. | "In C major the vi chord is A minor: A C E." |
| **M3.8** *(optional)* | Inversions and a smooth voicing | The same chord with a different lowest note: C/E, C/G. The **root** is still C. Moving the notes close together makes smoother changes. | "Play C chord with E on the bottom (first inversion)." | Pitch-class set the same, lowest pitch class = 4. | "The notes are right; the lowest one should be E." |

Unlocks after M3: chord labelling and "chord stamp" helper in the DAW piano roll (a quick way to place a chord).

---

## 9. Module M4 - Chord progressions

| Id | Sub-lesson | Watch / Teach | Practice | Check | Feedback |
|---|---|---|---|---|---|
| **M4.1** | Chords in time | One chord per bar, repeated. A progression = a sequence of chords. 4 bars, one chord each. | "Place C in bar 1, F in bar 2, G in bar 3, C in bar 4." | `progression`: per-bar chord = expected. | "Bar 2 has C but the task says F." |
| **M4.2** | Home, tension, release | **I = home**. **V = tension that wants to go home**. A chord sequence that ends on V feels unfinished; ending on I feels finished. Listen both. | "Build the progression I-V-I in C." "Which ending sounds finished?" | Progression + quiz. | "End on the I chord (C) to sound finished." |
| **M4.3** | The most popular progression: I-V-vi-IV | In C: **C G Am F**. In G: G D Em C. Thousands of songs use it. | "Build it in C", then "Build it in G". | Chord degrees per bar match I V vi IV for the key. | "Bar 3 should be the vi chord: A minor, not A major." |
| **M4.4** | More classics | **I-vi-IV-V** (C Am F G), **ii-V-I** (Dm G C), **vi-IV-I-V** (Am F C G). | "Build I-vi-IV-V in F", "Build ii-V-I in C". | Degree check. | Names the expected chord. |
| **M4.5** | Make your own progression | Free choice, **checked by rules**: 4 bars, every chord is in the key, and the last chord is I or V. | "Pick any key and write a 4-chord progression you like." | Rule checks (see `progression-free`); gives suggestions, not a pass/fail on taste. | "Chord in bar 3 is not in G major; try Em or C." |
| **M4.6** | Make chords move: rhythm and a bass note | Chords can be held, repeated (8th notes), or stabbed (on beats 1 and 3). Add the **root note** an octave lower as a bass. | "Play your progression as 8th-note chords with the root as a bass note." | Bass note = root of each bar's chord; rhythmic pattern present. | "Bar 2's bass should be F (the chord's root)." |

Unlocks after M4: second track (bass), loop/duplicate clip helpers.

---

## 10. Module M5 - Melody

| Id | Sub-lesson | Watch / Teach | Practice | Check | Feedback |
|---|---|---|---|---|---|
| **M5.1** | A melody from a scale | Stepwise motion (neighbours) sounds smooth; leaps add excitement. Over a C chord, use C major notes. | "Write 8 notes in C major; use mostly steps." | All notes in scale; >= 60% intervals of 1-2 semitones. | "Many big jumps; try neighbouring notes." |
| **M5.2** | Chord tones | Notes from the **current chord** (C E G over C) sound stable on strong beats (1 and 3). | "Over this C-F-G-C progression, start each bar on a note of that bar's chord." | First note of each bar is in that bar's chord. | "Bar 2 starts on E; the chord is F (F A C). Try A." |
| **M5.3** | Rhythm of a melody | Mix long and short notes; repeat a rhythm; leave rests. | "Write a melody that uses at least two different note lengths and one rest." | >= 2 distinct durations; at least one gap. | "All notes are the same length; vary a few." |
| **M5.4** | Motif and repetition | A short **idea** (a motif) repeated, then changed slightly (question and answer). | "Write a 2-bar motif, then repeat it in bars 3-4 with the last note changed." | Bars 3-4 similar to bars 1-2 (>= 60% notes equal) but not identical. | "Bars 3-4 are exactly the same; change the last note for an 'answer'." |
| **M5.5** | Project: melody over your progression | Combine M4 and M5. | "Write a 4-bar melody over the progression from M4.5." | Rules: in key; strong-beat chord tones >= 60%; at least 2 note lengths; ends on a chord tone. | Lists each unmet rule. |

Unlocks after M5: second synth track / instrument choice, copy-clip tools.

---

## 11. Module M6 - Rhythm and drums

| Id | Sub-lesson | Watch / Teach | Practice | Check | Feedback |
|---|---|---|---|---|---|
| **M6.1** | Beat, bar and tempo | The beat = the pulse you tap. Bar = 4 beats. Tempo = beats per minute. Metronome plays; 70 / 100 / 140 BPM feel. | "Set the tempo to 120 and clap along (press 4 keys on the beat)." | Tempo value; tap timing within 150 ms. | "A little early; wait for the click." |
| **M6.2** | Meet the drum kit | The drum track uses **rows as instruments**: kick (36), snare (38), clap (39), hats (42 closed, 46 open). Click rows to hear them. | "Find the kick, the snare and the closed hat." | Rows clicked. | "That row is the open hat (it rings longer)." |
| **M6.3** | The basic beat | **Kick on 1 and 3, snare on 2 and 4, closed hat on every 8th note.** The roll draws it, then plays it with the bass. | "Build the basic beat in one bar." | Rhythm grid: positions per drum row. | "Snare belongs on beats 2 and 4." |
| **M6.4** | Variations and off-beats | Kick on the "and" of 2; open hat on the off-beat; four-on-the-floor (kick every beat). | "Turn the basic beat into four-on-the-floor." | Rhythm grid (kick on 1,2,3,4). | Lists missing kick positions. |
| **M6.5** | Build a drum loop | Combine into a 2-bar loop; copy it to 4 bars. | "Make a 2-bar drum loop of your own: needs kick, snare, hats." | Rules: all three instruments used; at least 8 hits per bar. | "No hats yet; add a hat row." |

Unlocks after M6: drum track, Paint tool, Quantize.

---

## 12. Modules M7-M11 (DAW production lessons; outline, same loop)

These teach **features of the DAW** (this is where the learning module hands over to the beginner-friendly DAW). Each lesson ends with a task done *in the real DAW*.

| Module | Sub-lessons |
|---|---|
| **M7 Bass and layering** | M7.1 What a bassline does (root notes, one octave down) · M7.2 Add a bass track · M7.3 Make parts fit (don't clash: bass low, chords middle, melody high) · M7.4 Velocity: soft and loud notes |
| **M8 Arranging a song** | M8.1 Song sections (intro, verse, chorus, outro) · M8.2 Clips: what they are, create and move · M8.3 Copy a clip to repeat a section · M8.4 Split a clip to make a variation · M8.5 Song length and the loop |
| **M9 Mixing basics** | M9.1 Why mix: balance · M9.2 Volume faders (set bass vs melody) · M9.3 Pan: left and right · M9.4 Mute and solo to hear one part · M9.5 Meters and not clipping |
| **M10 Finish and share** | M10.1 Check the whole song from the start · M10.2 Set the song length · M10.3 Export a WAV |
| **M11 Capstone** | M11.1 Plan (key, tempo, sections) · M11.2 Chords + bass + drums · M11.3 Melody + arrangement · M11.4 Mix and export: **a complete song** |

### DAW feature unlock map (interface to the adaptive DAW component)

| Feature | Unlocked by (lesson completed) |
|---|---|
| Draw, Select, Delete, Undo/Redo, Play/Loop, Tempo | M0.1-M0.5 |
| Snap and grid size | M0.4 |
| Copy, Paste, Duplicate | M0.5 |
| Scale highlighting, out-of-key red notes | M2.6 |
| Chord helper (stamp a chord) | M3.6 |
| Multiple synth tracks | M4.6 |
| Paint, Quantize, Slice, Mute-note tools | M6.4 (Paint, Quantize), M8.4 (Slice), M7.4 (Mute note) |
| Drum tracks | M6.2 |
| Arrangement view and clips | M8.2 |
| Mixer (volume, pan) | M9.2 |
| Mute / Solo | M9.4 |
| Export WAV | M10.3 |

The lessons only **publish** a `lesson.completed` event; the unlock logic belongs to the Beginner-Friendly Adaptive DAW component.

---

## 13. Build order for the learning module (suggested)

1. **Lesson player and data format** (`LESSON-FORMAT.md`): load a lesson file, run Hook -> Watch -> Try -> Practice -> Check -> Done.
2. **Lesson piano roll** with three modes: *demo* (scripted drawing + sound), *guided* (ghost notes, red wrong notes), *practice* (blank, restricted).
3. **Checker library** as **pure, unit-tested functions** (pitch classes, chords, scales, progressions, rhythm grids).
4. **M0** (6 sub-lessons) end to end. Test with a real beginner before writing more.
5. **M1-M3** (notes, scales, chords).
6. **M4-M5**, then **M6**.
7. Telemetry (attempts, time, hints) and the `lesson.completed` event.
8. M7-M11 once the DAW unlock registry exists.

**Definition of done for a sub-lesson:** it has all stages, every Practice has a passing and a failing automated test of its checker, every mistake code has a human message, and a beginner has completed it without help.
