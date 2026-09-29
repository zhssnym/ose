// What Chrome has and TypeScript's DOM library does not yet declare, for checkJs over src/web
// (docs/WEB.md). The async iteration of a folder comes from the `dom.asynciterable` library
// (tsconfig.json); what is here is the rest: the pickers, the permission calls, `move`, the
// FileSystemObserver, the launch queue and the build flag.

/** Set by vite.web.config.js: true in the Ose Web build, absent everywhere else. */
declare const __OSE_WEB__: boolean | undefined;

type FsaPermissionMode = 'read' | 'readwrite';

interface FileSystemHandle {
  queryPermission(descriptor?: { mode?: FsaPermissionMode }): Promise<PermissionState>;
  requestPermission(descriptor?: { mode?: FsaPermissionMode }): Promise<PermissionState>;
  /** Chrome: `move(newName)` or `move(newParent, newName?)`. */
  move(newName: string): Promise<void>;
  move(newParent: FileSystemDirectoryHandle, newName?: string): Promise<void>;
  remove?(options?: { recursive?: boolean }): Promise<void>;
}

interface FsaPickerType { description?: string; accept: Record<string, string[]> }

interface Window {
  showDirectoryPicker?(options?: { id?: string; mode?: FsaPermissionMode; startIn?: FileSystemHandle | string }): Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?(options?: { id?: string; multiple?: boolean; excludeAcceptAllOption?: boolean; types?: FsaPickerType[]; startIn?: FileSystemHandle | string }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: { id?: string; suggestedName?: string; types?: FsaPickerType[]; startIn?: FileSystemHandle | string }): Promise<FileSystemFileHandle>;
  launchQueue?: LaunchQueue;
  FileSystemObserver?: FileSystemObserverConstructor;
}

type FileSystemChangeType = 'appeared' | 'disappeared' | 'modified' | 'moved' | 'unknown' | 'errored';

interface FileSystemChangeRecord {
  readonly root: FileSystemHandle;
  readonly changedHandle: FileSystemHandle | null;
  readonly relativePathComponents: string[];
  readonly type: FileSystemChangeType;
  readonly relativePathMovedFrom?: string[] | null;
}

interface FileSystemObserver {
  observe(handle: FileSystemHandle, options?: { recursive?: boolean }): Promise<void>;
  unobserve(handle: FileSystemHandle): void;
  disconnect(): void;
}

interface FileSystemObserverConstructor {
  new (callback: (records: FileSystemChangeRecord[], observer: FileSystemObserver) => void): FileSystemObserver;
}

interface LaunchParams { readonly targetURL?: string; readonly files: readonly FileSystemHandle[] }
interface LaunchQueue { setConsumer(consumer: (params: LaunchParams) => void): void }
