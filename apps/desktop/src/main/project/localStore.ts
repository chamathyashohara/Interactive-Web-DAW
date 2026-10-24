import fs from "node:fs";
import path from "node:path";
import { applyOp, createProject, migrateProject, type Op, type Project } from "@daw/shared";

interface SnapshotFile {
  /** Number of journal entries already folded into `project`. */
  seq: number;
  project: Project;
}

interface JournalLine {
  seq: number;
  op: Op;
}

const SNAPSHOT_EVERY = 200;

/**
 * Local persistence: atomic snapshot + append-only journal.
 * Every applied op is appended to the journal immediately (survives an app kill);
 * every SNAPSHOT_EVERY ops the journal is folded into a new snapshot (tmp file + rename).
 * No Electron imports, so it is unit-testable in plain Node.
 */
export class LocalStore {
  private seq = 0;
  private snapshotSeq = 0;
  private journalFd: number | null = null;

  constructor(private readonly dir: string) {}

  private get snapshotPath() {
    return path.join(this.dir, "snapshot.json");
  }
  private get journalPath() {
    return path.join(this.dir, "journal.ndjson");
  }

  /** Loads the project (snapshot + journal replay) or creates a fresh one. */
  open(newProjectId: string): Project {
    fs.mkdirSync(this.dir, { recursive: true });

    let project: Project | null = null;
    if (fs.existsSync(this.snapshotPath)) {
      try {
        const file = JSON.parse(fs.readFileSync(this.snapshotPath, "utf8")) as SnapshotFile;
        project = migrateProject(file.project);
        this.snapshotSeq = file.seq;
      } catch {
        project = null; // corrupt snapshot: fall back to the journal only
        this.snapshotSeq = 0;
      }
    }
    project ??= createProject(newProjectId);
    this.seq = this.snapshotSeq;

    if (fs.existsSync(this.journalPath)) {
      const lines = fs.readFileSync(this.journalPath, "utf8").split("\n");
      let validBytes = 0;
      let offset = 0;
      for (const raw of lines) {
        const lineBytes = Buffer.byteLength(raw, "utf8") + 1;
        if (raw.trim() === "") {
          offset += lineBytes;
          continue;
        }
        let entry: JournalLine;
        try {
          entry = JSON.parse(raw) as JournalLine;
        } catch {
          break; // torn final write after a kill: ignore the tail
        }
        offset += lineBytes;
        validBytes = offset;
        if (entry.seq <= this.snapshotSeq) continue;
        const result = applyOp(project, entry.op);
        if (result.ok) project = result.project;
        this.seq = entry.seq;
      }
      // Drop any torn tail so future appends start on a clean line.
      const size = fs.statSync(this.journalPath).size;
      if (validBytes < size) fs.truncateSync(this.journalPath, Math.min(validBytes, size));
    }

    this.journalFd = fs.openSync(this.journalPath, "a");
    return project;
  }

  /** Persists an op that was just applied successfully. Call `maybeSnapshot` afterwards. */
  append(op: Op): void {
    if (this.journalFd === null) throw new Error("store not open");
    this.seq += 1;
    const line: JournalLine = { seq: this.seq, op };
    fs.writeSync(this.journalFd, JSON.stringify(line) + "\n");
  }

  maybeSnapshot(project: Project): void {
    if (this.seq - this.snapshotSeq >= SNAPSHOT_EVERY) this.snapshot(project);
  }

  snapshot(project: Project): void {
    const tmp = this.snapshotPath + ".tmp";
    const file: SnapshotFile = { seq: this.seq, project };
    fs.writeFileSync(tmp, JSON.stringify(file));
    fs.renameSync(tmp, this.snapshotPath);
    this.snapshotSeq = this.seq;
    // Journal entries up to seq are now in the snapshot; start a fresh journal.
    if (this.journalFd !== null) fs.closeSync(this.journalFd);
    fs.writeFileSync(this.journalPath, "");
    this.journalFd = fs.openSync(this.journalPath, "a");
  }

  close(): void {
    if (this.journalFd !== null) fs.closeSync(this.journalFd);
    this.journalFd = null;
  }
}
