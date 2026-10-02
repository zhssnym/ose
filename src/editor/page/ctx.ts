// Part of the markdown page (../page.ts). The context one page instance shares.
//
// `buildPage` makes one `ctx` per instance. It holds the instance's state (what the closure
// held before the page was cut into parts) and every part's functions, and each part reaches the
// others through it: `ctx.page` is the file on screen, `ctx.saveDoc(p)` a save.

import type { Draft_Serialize, ReadFile } from '../../core/bridge/commands.ts';
import type { PlainDoc, PageState, PageInstance, DocState } from './shared.ts';

/** The instance's state. */
export interface PageVars {
  el: any;
  path: any;
  opts: any;
  page: null | PageState;
  openToken: number;
  opening: Promise<void>;
  closed: boolean;
  leaving: Promise<boolean> | null;
  parked: boolean;
  parkScroll: number;
  parkFocus: boolean;
  listeners: Map<any, any>;
  inst: PageInstance;
  api: any;
  handle: any;
}

/** Every part's functions, as `install<Part>(ctx)` adds them. */
export interface PageFns {
  // events.ts
  isActive: () => boolean;
  setStatus: (field: any, value: any) => void;
  emit: (event: any, payload: any) => void;
  on: (event: any, fn: any) => () => void;
  // open.ts
  open: (nextPath: any, options?: any) => Promise<void>;
  readDraft: (path: any) => Promise<Draft_Serialize | null>;
  mountBody: (p: any, text: any, token?: any, o?: any) => any;
  unmountBody: (p: any) => Promise<void>;
  closePage: ({ keepAlive }?: { keepAlive?: boolean | undefined; }) => Promise<boolean>;
  plainDoc: (text: any) => PlainDoc;
  run: (nextPath: any, options: any) => Promise<void>;
  // modes.ts
  toggleSource: () => Promise<boolean>;
  nextMode: () => Promise<boolean>;
  setMode: (want: any, o?: any) => Promise<boolean>;
  switchTo: (p: any, want: any, o: any) => Promise<boolean>;
  mountFallback: (p: any, text: any) => Promise<boolean>;
  remount: (p: any, mode: any, text: any) => Promise<any>;
  forceSource: (p: any, text: any, forced: any, reason: any) => Promise<void>;
  publicMode: (p: any) => any;
  publishMode: (p: any) => void;
  paintMode: (p: any) => void;
  scrollToLine: (line: any, col: any) => boolean;
  openFindWith: (p: any, query: any) => void;
  restoreSelection: (p: any, sel: any) => void;
  currentSelection: () => { from: any; to: any; } | null;
  focusTitle: (p: any) => void;
  saveNow: (o?: any) => any;
  // leave.ts
  canLeave: (_reason: string) => Promise<boolean>;
  leaveWindow: () => Promise<boolean>;
  unchecked: (p: any) => boolean;
  leaveAsDraft: (p: any) => Promise<boolean>;
  stay: () => void;
  freeze: (p: any) => void;
  unfreeze: (p: any) => void;
  setEditable: (p: any, on: any) => void;
  beforePathChange: (change: any) => Promise<{ ok: boolean; reason?: undefined; } | { ok: boolean; reason: string; }>;
  afterPathChange: (change: any) => Promise<void>;
  // dom.ts
  buildDom: (p: any, host: any) => void;
  makeTitleEl: (p: any, text: any) => HTMLHeadingElement;
  onTitleDone: (p: any) => Promise<void>;
  propertiesStrip: (p: any) => HTMLDivElement;
  wirePropEdit: (p: any, v: any, key: any) => void;
  onTitleKey: (e: any) => void;
  focusBody: () => void;
  focusTitleEnd: (p: any) => boolean;
  selectAllWithTitle: (p: any) => boolean;
  clearTitleSelection: (p: any) => void;
  wholeNote: (p: any) => any;
  addTitle: (p: any) => void;
  applySpellcheck: (p: any) => void;
  wireEditorEvents: (p: any) => void;
  onEditorBlur: (p: any) => void;
  onLinkPointerDown: (e: any) => void;
  onLinkClick: (e: any) => void;
  followLink: (href: any) => Promise<void>;
  resolveImage: (p: any, src: any) => string;
  attachFile: (p: any, file: any) => Promise<string>;
  uploadImage: (p: any, file: any) => Promise<string>;
  wireDrops: (p: any) => void;
  // status.ts
  publishTitle: (p: any) => void;
  statusOf: (p: any) => any;
  stateOf: (p: any) => DocState;
  publishState: (p: any) => void;
  paintSave: (p: any, s?: DocState) => void;
  bannerSpec: (p: any) => { kind: string; alert: boolean; text: string; buttons: [string, string][]; } | null;
  renderBanner: (p: any) => void;
  focusBanner: (p: any) => boolean;
  setDirty: (p: any, dirty: any) => void;
  // save.ts
  markDirty: (p: any) => void;
  encodingOpts: (p: any) => { encoding?: undefined; } | { encoding: any; };
  readOpts: (p: any) => { encoding: any; } | undefined;
  readsOtherwise: (p: any, file: { encoding?: string | null | undefined; lossy?: boolean | null | undefined; }) => boolean;
  readAs: (file: any) => string;
  readOtherwise: (p: any, file: any) => Promise<void>;
  autosaveHeld: (p: any) => any;
  composeChecked: (p: any) => { status: "unsafe" | "ok" | "fellBack"; text: string | null; reason?: string | undefined; };
  bestEffort: (p: any) => any;
  saveDoc: (p: any, o?: any) => any;
  writeOut: (p: any, text: any, rev: any, opts: any) => Promise<boolean | "again">;
  saved: (p: any, text: any, res: any, rev: any) => void;
  settleClean: (p: any, rev: any) => void;
  saveFailed: (p: any, e: any) => void;
  refuseUnsafe: (p: any, r: any) => Promise<void>;
  // merge.ts
  mergeExternal: (p: any, disk: any) => Promise<"conflict" | "same" | "reloaded" | "merged">;
  reloadClean: (p: any, text: any, hash: any) => Promise<void>;
  applyText: (p: any, text: any) => Promise<boolean>;
  applyRich: (p: any, text: any) => boolean;
  holdConflict: (p: any, info: any) => void;
  readDisk: (p: any) => Promise<{ text: null; hash: string; file: ReadFile; } | { text: string | null; hash: string; file?: undefined; } | { text: null; hash: null; file?: undefined; } | null>;
  resolveMerge: (p: any) => any;
  keepBothIn: (p: any, ours: any, c: any) => Promise<boolean>;
  keepMine: (p: any, o?: any) => any;
  takeTheirs: (p: any, o?: any) => Promise<boolean>;
  confirmLoss: (p: any, o: { title: string; body: string; ok: string; text: string; }) => Promise<boolean>;
  showMergeNote: (p: any) => void;
  clearMergeNote: (p: any) => void;
  canUndoMerge: (p: any) => boolean;
  undoMerge: (p: any) => Promise<boolean>;
  showMerge: (p: any) => Promise<void>;
  keepDisk: (p: any, text: any) => Promise<void>;
  keepBuffer: (p: any, text: any) => Promise<void>;
  // drafts.ts
  draftText: (p: any) => { text: any; exact: boolean; };
  scheduleDraft: (p: any) => void;
  writeDraft: (p: any) => Promise<void>;
  draftOp: (p: any, fn: any) => any;
  keepRecovered: (p: any) => Promise<boolean>;
  writeDraftText: (p: any, text: any, exact: any) => any;
  dropDraft: (p: any, rev?: any) => any;
  ownsDraft: (p: any) => Promise<boolean>;
  updateMeta: (p: any, recount?: boolean) => void;
  pageText: (p: any) => any;
  // watch.ts
  onFsChange: (payload: any) => void;
  opensAs: (from: any, to: any) => boolean;
  checkDisk: (p: any, depth?: number) => Promise<void>;
  goneCheck: (p: any) => void;
  markDeleted: (p: any) => void;
  followRename: (p: any, to: any) => void;
  reopenInPlace: (p: any) => Promise<void>;
  // actions.ts
  outlinePage: () => Promise<void>;
  linkPage: () => Promise<void>;
  copyMarkdown: () => Promise<void>;
  saveAs: () => Promise<boolean>;
  discardChanges: () => Promise<boolean>;
  recoveredCompare: () => Promise<void>;
  recoveredRestore: () => Promise<boolean>;
  focusPage: () => void;
  saveUtf8: () => Promise<any>;
  reopenEncoding: () => Promise<boolean>;
  // park.ts
  repaint: () => void;
  take: () => void;
  release: () => void;
  park: () => boolean;
  reattach: (host: any, o?: any) => void;
  letGo: () => Promise<boolean>;
  // links.ts
  rewriteLinks: (target: any, pairs: any, o?: any) => Promise<{ handled: boolean; changed?: number | undefined; failed?: string | undefined; }>;
  rewriteRich: (view: any, target: any, list: any, o: any) => number;
}

/** One page instance. */
export interface PageCtx extends PageVars, PageFns {}
