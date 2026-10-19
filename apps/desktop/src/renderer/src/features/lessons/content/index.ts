import type { Lesson } from "../types";
import { chords1 } from "./chords-1";
import { melody1 } from "./melody-1";
import { midiEditing1 } from "./midi-editing-1";
import { rhythm1 } from "./rhythm-1";

/** Lessons in the order the learner sees them. */
export const LESSONS: Lesson[] = [chords1, melody1, rhythm1, midiEditing1];
