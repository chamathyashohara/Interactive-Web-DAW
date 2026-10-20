import type { Lesson, SubLesson } from "../types";
import { chords1 } from "./chords-1";
import { M0 } from "./m0";
import { m3RootNote } from "./m3-root-note";
import { melody1 } from "./melody-1";
import { midiEditing1 } from "./midi-editing-1";
import { rhythm1 } from "./rhythm-1";

/** Lessons in the order the learner sees them. */
export const LESSONS: Lesson[] = [chords1, melody1, rhythm1, midiEditing1];

/** Every written sub-lesson of the learning path (modules and their order are in curriculum.ts). */
export const SUB_LESSONS: SubLesson[] = [...M0, m3RootNote];
