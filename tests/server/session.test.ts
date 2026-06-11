import { describe, expect, it } from 'vitest';

import { Session } from '../../src/session.js';
import { ShapeDocument } from '../../src/vs/document.js';
import { addElement } from '../../src/vs/elements.js';

const makeDoc = (): ShapeDocument => ShapeDocument.create({ textureWidth: 16, textureHeight: 16 });

describe('Session registry', () => {
  it('hands out monotonic ids d1, d2, … (no id reuse after close)', () => {
    const session = new Session();
    const a = session.open(makeDoc());
    const b = session.open(makeDoc());
    expect(a.id).toBe('d1');
    expect(b.id).toBe('d2');
    session.close('d1');
    const c = session.open(makeDoc());
    expect(c.id).toBe('d3'); // ids are never recycled — stale references must not alias
    expect(session.list().map((m) => m.id)).toEqual(['d2', 'd3']);
  });

  it('get() throws for unknown ids, listing the known ones', () => {
    const session = new Session();
    session.open(makeDoc(), { origin: 'corpus:entity/test' });
    session.open(makeDoc(), { origin: '(created)' });
    expect(() => session.get('d9')).toThrowError(/No open document with id 'd9'/);
    expect(() => session.get('d9')).toThrowError(/d1 \(corpus:entity\/test\)/);
    expect(() => session.get('d9')).toThrowError(/d2 \(\(created\)\)/);
    expect(() => session.get('d9')).toThrowError(/shape_open/);
  });

  it('get() with no docs open says so', () => {
    const session = new Session();
    expect(() => session.get('d1')).toThrowError(/no documents are open/);
  });

  it('close() removes the entry and throws for unknown ids', () => {
    const session = new Session();
    const m = session.open(makeDoc());
    expect(session.close(m.id).id).toBe(m.id);
    expect(() => session.get(m.id)).toThrowError(/No open document/);
    expect(() => session.close(m.id)).toThrowError(/No open document/);
  });

  it('tracks origin and savePath independently', () => {
    const session = new Session();
    const m = session.open(makeDoc(), { savePath: 'C:/tmp/x.json', origin: 'C:/tmp/x.json' });
    expect(m.origin).toBe('C:/tmp/x.json');
    expect(m.savePath).toBe('C:/tmp/x.json');
    const corpusDoc = session.open(makeDoc(), { origin: 'corpus:entity/foo' });
    expect(corpusDoc.savePath).toBeUndefined();
    expect(corpusDoc.origin).toBe('corpus:entity/foo');
  });
});

describe('ManagedDoc dirty tracking', () => {
  it('is clean on open, dirty after an edit, clean again after undoing every edit', () => {
    const session = new Session();
    const m = session.open(makeDoc());
    expect(m.dirty).toBe(false);

    m.doc.transact("element_add 'box'", () =>
      addElement(m.doc, { name: 'box', from: [0, 0, 0], to: [4, 4, 4], faces: 'none' }),
    );
    expect(m.dirty).toBe(true);

    // Undo restores byte-identically, so the dirty flag must drop back to false.
    expect(m.doc.undo()).toBe("element_add 'box'");
    expect(m.dirty).toBe(false);

    expect(m.doc.redo()).toBe("element_add 'box'");
    expect(m.dirty).toBe(true);
  });

  it('markClean() establishes a new clean point (what shape_save does)', () => {
    const session = new Session();
    const m = session.open(makeDoc());
    m.doc.transact("element_add 'box'", () =>
      addElement(m.doc, { name: 'box', from: [0, 0, 0], to: [4, 4, 4], faces: 'none' }),
    );
    expect(m.dirty).toBe(true);
    m.markClean();
    expect(m.dirty).toBe(false);
    // Undoing PAST the clean point makes the doc dirty relative to the saved text again.
    m.doc.undo();
    expect(m.dirty).toBe(true);
  });
});
