/**
 * A one-line pub/sub so the persistence layer can tell the cloud-save
 * layer that something changed, without the two importing each other.
 *
 * `state/cloudSave` reads settings / difficulty / records, so those
 * modules cannot import it back to announce a write. They publish
 * here instead and cloudSave subscribes.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** @returns an unsubscribe function. */
export function onLocalStateChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Called by the `save*` helpers after they write to localStorage. */
export function notifyLocalStateChanged(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* a broken listener must not break the write that triggered it */
    }
  }
}
