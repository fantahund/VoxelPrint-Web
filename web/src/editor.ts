/**
 * What the preview's editor can do, and how to take it back.
 *
 * <p>An edit is kept as the change itself rather than as a snapshot of
 * everything. A build can hold hundreds of thousands of blocks, and copying the
 * whole removal set on every click would make a long session cost more the
 * longer it ran. A change knows both ways round, so undo is the same machinery
 * as redo with the step reversed.
 *
 * <p>Every edit is reversible on its own terms. Removing blocks remembers which
 * ones it actually removed -- not which ones were asked for -- so undoing it
 * cannot put back a block that was already gone before.
 */

export interface EditorState {
  /** Blocks taken out by hand, as indices into the selection. */
  readonly removed: ReadonlySet<number>;
  /** Which filament each block type prints in. */
  readonly assignment: Readonly<Record<string, number>>;
}

export type Edit =
  | {
      readonly kind: "remove";
      /** Exactly the blocks this edit took out, none of them gone already. */
      readonly blocks: readonly number[];
      readonly what: string;
    }
  | {
      readonly kind: "restore";
      readonly blocks: readonly number[];
      readonly what: string;
    }
  | {
      readonly kind: "assign";
      readonly blockId: string;
      readonly from: number;
      readonly to: number;
      readonly what: string;
    };

/** What to show on the undo button, in the past tense of what was done. */
export function describe(edit: Edit): string {
  switch (edit.kind) {
    case "remove":
      return edit.blocks.length === 1 ? `removing one ${edit.what}` : `removing ${edit.blocks.length} ${edit.what}`;
    case "restore":
      return edit.blocks.length === 1 ? `putting back one ${edit.what}` : `putting back ${edit.blocks.length} ${edit.what}`;
    case "assign":
      return `moving ${edit.what} to filament ${edit.to + 1}`;
  }
}

/** The same edit the other way round. */
export function invert(edit: Edit): Edit {
  switch (edit.kind) {
    case "remove":
      return { kind: "restore", blocks: edit.blocks, what: edit.what };
    case "restore":
      return { kind: "remove", blocks: edit.blocks, what: edit.what };
    case "assign":
      return { kind: "assign", blockId: edit.blockId, from: edit.to, to: edit.from, what: edit.what };
  }
}

/**
 * Carries out an edit.
 *
 * <p>Returns the state unchanged, by identity, when the edit would do nothing.
 * That lets the caller tell an edit worth recording from one that is not --
 * right clicking a block that is already gone, or picking the filament it is
 * already in.
 */
export function apply(state: EditorState, edit: Edit): EditorState {
  switch (edit.kind) {
    case "remove": {
      const next = new Set(state.removed);
      for (const block of edit.blocks) {
        next.add(block);
      }
      return next.size === state.removed.size ? state : { ...state, removed: next };
    }
    case "restore": {
      const next = new Set(state.removed);
      for (const block of edit.blocks) {
        next.delete(block);
      }
      return next.size === state.removed.size ? state : { ...state, removed: next };
    }
    case "assign": {
      if (state.assignment[edit.blockId] === edit.to) {
        return state;
      }
      return { ...state, assignment: { ...state.assignment, [edit.blockId]: edit.to } };
    }
  }
}

/**
 * Narrows a removal to the blocks that are actually there.
 *
 * <p>So that the edit recorded is the one that happened. Asked to clear away
 * every torch when half of them are already gone, an edit that claimed all of
 * them would, on undo, put back the half somebody had removed earlier for their
 * own reasons.
 *
 * @return the edit, or null when there is nothing left to remove
 */
export function removal(
  state: EditorState,
  blocks: readonly number[],
  what: string,
): Edit | null {
  const fresh = blocks.filter((block) => !state.removed.has(block));
  return fresh.length === 0 ? null : { kind: "remove", blocks: fresh, what };
}
