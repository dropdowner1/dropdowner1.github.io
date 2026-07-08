/**
 * Keyboard bindings: abstract game action → physical `KeyboardEvent.code`.
 *
 * Using `code` rather than `key` makes bindings layout-independent
 * (a user on a Dvorak keyboard still binds the physical Z/X keys).
 */

export type BindableAction = 'MOVE_L' | 'MOVE_R' | 'SOFT_DROP' | 'ROT_L' | 'ROT_R' | 'PAUSE';

export type Keybindings = Readonly<Record<BindableAction, string>>;

export const DEFAULT_KEYBINDINGS: Keybindings = {
  MOVE_L: 'ArrowLeft',
  MOVE_R: 'ArrowRight',
  SOFT_DROP: 'ArrowDown',
  ROT_L: 'KeyZ',
  ROT_R: 'KeyX',
  PAUSE: 'Escape',
};

/** Build a reverse lookup from a `Keybindings` map. */
export function buildKeyToAction(bindings: Keybindings): Map<string, BindableAction> {
  const out = new Map<string, BindableAction>();
  for (const action of Object.keys(bindings) as BindableAction[]) {
    out.set(bindings[action], action);
  }
  return out;
}
