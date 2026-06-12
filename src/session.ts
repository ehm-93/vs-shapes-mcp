/**
 * Open-document registry for the MCP server: docIds (`d1`, `d2`, …), save-path and
 * dirty tracking.
 *
 * Dirty tracking is exact, not flag-based: each entry remembers the serialized text of
 * its last clean point (open / create / save) and `dirty` re-serializes to compare.
 * That way undoing every edit makes the document clean again — which the acceptance
 * contract relies on (undo must restore byte-identically). Serialization of even the
 * largest vanilla shapes is far below a millisecond-budget concern at session scale.
 */

import type { ShapeDocument } from './vs/document.js';

export interface OpenDocOpts {
  /** Filesystem path shape_save defaults to (absolute). Unset for corpus/created docs. */
  savePath?: string;
  /** Human-readable source label: a file path, `corpus:<path>`, or `(created)`. */
  origin?: string;
}

/** One open document plus its session bookkeeping. */
export class ManagedDoc {
  /** Filesystem path shape_save defaults to; updated by every successful save. */
  savePath: string | undefined;
  /** Where the document came from, for listings and error messages. */
  readonly origin: string;
  #cleanText: string;

  constructor(
    readonly id: string,
    readonly doc: ShapeDocument,
    opts: OpenDocOpts = {},
  ) {
    this.savePath = opts.savePath;
    this.origin = opts.origin ?? opts.savePath ?? '(created)';
    this.#cleanText = doc.serialize();
  }

  /** True when the current tree serializes differently from the last clean point. */
  get dirty(): boolean {
    return this.doc.serialize() !== this.#cleanText;
  }

  /** Record the current tree (or the exact `text` just written to disk) as clean. */
  markClean(text?: string): void {
    this.#cleanText = text ?? this.doc.serialize();
  }
}

export class Session {
  #docs = new Map<string, ManagedDoc>();
  #nextId = 1;

  /** Register a document; returns its entry with a fresh id (`d1`, `d2`, …). */
  open(doc: ShapeDocument, opts: OpenDocOpts = {}): ManagedDoc {
    const id = `d${this.#nextId++}`;
    const entry = new ManagedDoc(id, doc, opts);
    this.#docs.set(id, entry);
    return entry;
  }

  /** Look up an open document; throws an error listing the known ids when absent. */
  get(id: string): ManagedDoc {
    const entry = this.#docs.get(id);
    if (entry !== undefined) return entry;
    const known = [...this.#docs.values()];
    throw new Error(
      `No open document with id '${id}'` +
        (known.length > 0
          ? ` — open documents: ${known.map((e) => `${e.id} (${e.origin})`).join(', ')}.`
          : ` — no documents are open.`) +
        ` Use shape_open or shape_create first (shape_list_open shows the registry),` +
        ` or pass a shape file path / 'corpus:' ref directly (stateless mode — no open needed).`,
    );
  }

  /**
   * The open document most recently bound to `path` (absolute), if any. Path-addressed
   * (stateless) tool calls resolve through this first so a working copy opened with
   * shape_open and edits addressed by file path compose on one live document instead of
   * forking into two in-memory copies that clobber each other on save.
   */
  findBySavePath(path: string): ManagedDoc | undefined {
    let found: ManagedDoc | undefined;
    for (const entry of this.#docs.values()) {
      if (entry.savePath === path) found = entry;
    }
    return found;
  }

  /** Close (deregister) a document; returns the removed entry. Throws when unknown. */
  close(id: string): ManagedDoc {
    const entry = this.get(id);
    this.#docs.delete(id);
    return entry;
  }

  /** All open documents, in open order. */
  list(): ManagedDoc[] {
    return [...this.#docs.values()];
  }
}
