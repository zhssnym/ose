// The internal drag of rows: a sidebar row dragged onto a folder row (a move) or over the tab
// strip (a tab). Nothing is dragged in from the system and nothing drags a vault file out: a
// drop from Explorer or Finder lands nowhere (layout.ts ignores it), except an image dropped
// into an open page, which the editor attaches.

/** The private type an internal drag carries: a JSON list of vault paths (C17). */
export const DRAG_TYPE = 'application/x-os-path';

// The paths an internal drag carries, while it lasts: `getData` is unreadable during dragover,
// and the tree needs them there to know which folders may light up.
let draggedNow: string[] | null = null;

/** Say which vault paths a drag that started in this window carries (null when it ends). */
export function setDragged(paths: string[] | null) { draggedNow = paths && paths.length ? [...paths] : null; }

/** The vault paths the drag in progress carries, when it started in this window. */
export const dragged = (): string[] | null => draggedNow;

/** Whether a drag is one of ours (a row of the tree). */
export const isInternal = (dt: DataTransfer | null | undefined): boolean => !!dt && [...(dt.types || [])].includes(DRAG_TYPE);
