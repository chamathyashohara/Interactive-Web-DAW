import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createProject, migrateProject, type Project } from "@daw/shared";
import { LocalStore } from "./localStore";

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  modifiedAt: number;
}

interface WorkspaceIndex {
  projects: Record<string, ProjectMeta>;
  /** Project ids, most-recently-opened first. */
  recent: string[];
}

const MAX_NAME = 80;
const SNAPSHOT = "snapshot.json";

/**
 * Manages many named projects on disk, each in its own folder (`<root>/<id>/`) using the same durable
 * snapshot + journal format as a single project. An `index.json` holds each project's name and times and the
 * recently-opened order. No Electron imports, so it is unit-testable in plain Node.
 *
 * It owns identity and metadata only; the live editing of one project still goes through ProjectService + LocalStore.
 */
export class Workspace {
  private index: WorkspaceIndex;

  constructor(
    private readonly root: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    fs.mkdirSync(root, { recursive: true });
    this.index = this.load();
    this.adoptStrayFolders(); // pick up a project folder that exists on disk but is not in the index (e.g. the old single "default")
    this.persist();
  }

  private get indexPath() {
    return path.join(this.root, "index.json");
  }
  private dirFor(id: string) {
    return path.join(this.root, id);
  }

  private load(): WorkspaceIndex {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, "utf8")) as WorkspaceIndex;
      if (raw && typeof raw === "object" && raw.projects) return { projects: raw.projects, recent: Array.isArray(raw.recent) ? raw.recent : [] };
    } catch {
      /* missing or corrupt: rebuilt from the folders below */
    }
    return { projects: {}, recent: [] };
  }

  private persist() {
    const tmp = this.indexPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.index, null, 2));
    fs.renameSync(tmp, this.indexPath);
  }

  /** A folder with a snapshot/journal but no index entry (an older layout, or a hand-copied project) is adopted. */
  private adoptStrayFolders() {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || this.index.projects[e.name]) continue;
      const dir = this.dirFor(e.name);
      if (!fs.existsSync(path.join(dir, SNAPSHOT)) && !fs.existsSync(path.join(dir, "journal.ndjson"))) continue;
      const name = this.readName(dir) ?? "Recovered project";
      const t = this.folderTime(dir);
      this.index.projects[e.name] = { id: e.name, name, createdAt: t, modifiedAt: t };
      if (!this.index.recent.includes(e.name)) this.index.recent.push(e.name);
    }
  }

  private readName(dir: string): string | null {
    try {
      const file = JSON.parse(fs.readFileSync(path.join(dir, SNAPSHOT), "utf8")) as { project?: Project };
      const n = file.project?.name?.trim();
      return n ? n.slice(0, MAX_NAME) : null;
    } catch {
      return null;
    }
  }
  private folderTime(dir: string): number {
    try {
      return Math.round(fs.statSync(dir).mtimeMs);
    } catch {
      return this.now();
    }
  }

  private cleanName(name: unknown, fallback: string): string {
    const n = typeof name === "string" ? name.trim() : "";
    return (n || fallback).slice(0, MAX_NAME);
  }

  /** Writes a fresh seed snapshot so the folder is immediately openable by LocalStore/ProjectService. */
  private seed(id: string, name: string) {
    const dir = this.dirFor(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SNAPSHOT), JSON.stringify({ seq: 0, project: createProject(id, name) }));
  }

  /** Projects, most-recently-opened first, then any not in the recent list by newest first. */
  list(): ProjectMeta[] {
    const seen = new Set<string>();
    const out: ProjectMeta[] = [];
    for (const id of this.index.recent) {
      const m = this.index.projects[id];
      if (m && !seen.has(id)) (seen.add(id), out.push(m));
    }
    for (const m of Object.values(this.index.projects).sort((a, b) => b.modifiedAt - a.modifiedAt)) if (!seen.has(m.id)) out.push(m);
    return out;
  }

  exists(id: string): boolean {
    return !!this.index.projects[id];
  }
  meta(id: string): ProjectMeta | null {
    return this.index.projects[id] ?? null;
  }
  lastOpenedId(): string | null {
    return this.index.recent.find((id) => this.index.projects[id]) ?? this.list()[0]?.id ?? null;
  }

  /** A LocalStore bound to a project's folder (creates the folder/seed if needed). */
  storeFor(id: string): LocalStore {
    if (!this.index.projects[id]) throw new Error(`unknown project ${id}`);
    if (!fs.existsSync(path.join(this.dirFor(id), SNAPSHOT))) this.seed(id, this.index.projects[id]!.name);
    return new LocalStore(this.dirFor(id));
  }

  create(name?: string): ProjectMeta {
    const id = randomUUID();
    const t = this.now();
    const meta: ProjectMeta = { id, name: this.cleanName(name, "Untitled project"), createdAt: t, modifiedAt: t };
    this.seed(id, meta.name);
    this.index.projects[id] = meta;
    this.index.recent.unshift(id);
    this.persist();
    return meta;
  }

  /** Marks a project as the most recently opened and updates its modified time. */
  touch(id: string): void {
    const m = this.index.projects[id];
    if (!m) return;
    m.modifiedAt = this.now();
    this.index.recent = [id, ...this.index.recent.filter((x) => x !== id)];
    this.persist();
  }

  rename(id: string, name: string): ProjectMeta {
    const m = this.index.projects[id];
    if (!m) throw new Error(`unknown project ${id}`);
    m.name = this.cleanName(name, m.name);
    m.modifiedAt = this.now();
    // Keep the project's own model name in step (used by the DAW title and the collaboration seed).
    const snap = path.join(this.dirFor(id), SNAPSHOT);
    try {
      const file = JSON.parse(fs.readFileSync(snap, "utf8")) as { seq: number; project: Project };
      file.project = migrateProject({ ...file.project, name: m.name });
      fs.writeFileSync(snap, JSON.stringify(file));
    } catch {
      /* no snapshot yet (never opened): the seed will use the index name */
    }
    this.persist();
    return m;
  }

  /** Updates only the index name/time (used when the project is open and the editor owns its snapshot). */
  renameIndexOnly(id: string, name: string): ProjectMeta {
    const m = this.index.projects[id];
    if (!m) throw new Error(`unknown project ${id}`);
    m.name = this.cleanName(name, m.name);
    m.modifiedAt = this.now();
    this.persist();
    return m;
  }

  /** "Save As": a full copy of a project under a new id and name. */
  duplicate(id: string, name?: string): ProjectMeta {
    const src = this.index.projects[id];
    if (!src) throw new Error(`unknown project ${id}`);
    const copy = this.create(this.cleanName(name, `${src.name} copy`));
    const from = this.dirFor(id);
    const to = this.dirFor(copy.id);
    for (const f of ["snapshot.json", "journal.ndjson"]) {
      const s = path.join(from, f);
      if (fs.existsSync(s)) fs.copyFileSync(s, path.join(to, f));
    }
    // Rewrite the copy's identity so it is a distinct project (new id, new name), not a second window onto the original.
    const snap = path.join(to, SNAPSHOT);
    try {
      const file = JSON.parse(fs.readFileSync(snap, "utf8")) as { seq: number; project: Project };
      file.project = migrateProject({ ...file.project, id: copy.id, name: copy.name });
      fs.writeFileSync(snap, JSON.stringify(file));
    } catch {
      /* fall back to the seed already written by create() */
    }
    return copy;
  }

  delete(id: string): void {
    if (!this.index.projects[id]) return;
    delete this.index.projects[id];
    this.index.recent = this.index.recent.filter((x) => x !== id);
    fs.rmSync(this.dirFor(id), { recursive: true, force: true });
    this.persist();
  }

  /** Guarantees at least one project exists (first run / after deleting the last one) and returns the one to open. */
  ensureAtLeastOne(): ProjectMeta {
    const last = this.lastOpenedId();
    if (last && this.index.projects[last]) return this.index.projects[last]!;
    return this.create("My first project");
  }
}
