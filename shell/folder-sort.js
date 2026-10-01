// Part of the folder view (./folder.js). What the parts share.

import { ose } from 'ose:core';
import { hasIcon, icon } from 'ose:ui';
import * as M from './folder-model.js';
import { baseName, clean, titleOf, vaultName } from './paths.js';

export const { bus, commands, route } = ose;

/**
 * One row of a folder, as the host lists it (`ose.files.list`).
 * @typedef {{name: string, path: string, kind: string, ext?: string, mtime: number, size: number,
 *   hidden?: boolean, link?: string|null, readable?: boolean|null}} Row
 */
/** @typedef {{path: string, kind: 'file'|'dir'}} Target */

/** The route of a folder, with the child to select when there is one. */
export const folderRoute = (path, select) => (select ? { type: 'folder', path: clean(path), select } : { type: 'folder', path: clean(path) });

/** A folder's name as the chrome says it: its own name, the vault's at the root. */
export const folderName = (path) => (clean(path) ? baseName(path) : vaultName());

/** A name as the chrome shows it: the full name, `.md` stripped only when hideMdExt is on (W8). */
export function display(entry) {
  if (!entry || entry.kind === 'dir') return entry ? entry.name : '';
  return titleOf(entry.path) || entry.name;
}

/** An icon from the core's set, else the plain file or folder one: `icon()` falls back to a dot. */
export const iconSvg = (name, fallback = 'file') => icon(hasIcon(name) ? name : fallback);

export const showHidden = () => !!ose.settings.get().showHidden;

/** Every folder is sorted by name, folders first. */
export const sortSpec = () => M.DEFAULT_SORT;

export const SORT_WORDS = { name: 'Name', modified: 'Modified', size: 'Size', type: 'Type' };
// The columns, left to right, as Explorer's details view has them.
export const COLUMNS = ['name', 'type', 'modified', 'size'];
