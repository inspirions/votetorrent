/** Best-effort POSIX permissions (ignored on Windows / unsupported FSes). */
export declare const DIR_MODE = 448;
export declare const FILE_MODE = 384;
/**
 * Percent-encode a string into a filesystem-safe filename component. Beyond
 * `encodeURIComponent` (which already escapes `/`, spaces, and unicode), this
 * also escapes the unreserved characters `encodeURIComponent` leaves intact but
 * that are unsafe in filenames on some platforms (notably `*` on Windows) — and
 * `.`, so a file suffix appended by the caller is the only literal dot, making
 * suffix-stripping unambiguous — and every uppercase letter, because Windows
 * (NTFS) and macOS (APFS/HFS+ by default) ignore case in file names. Reversed by
 * `decodeURIComponent`.
 *
 * The result contains only `a-z0-9-_` and `%XX` escapes (uppercase hex). Since a
 * literal `%` is itself escaped, every `%` starts an escape, so ignoring case
 * can change only escape hex digits — which decode case-insensitively — and two
 * different inputs never yield names equal ignoring case. The escapes keep
 * `encodeURIComponent`'s uppercase hex so a name built from an id with no
 * capital letters (the identity slot `cadre%2Fidentity.key`, a lowercase party
 * id) is the same as before uppercase letters were escaped.
 */
export declare function encodeFileSafeComponent(component: string): string;
/** Whether an unknown error is a Node "file/dir not found" (ENOENT). */
export declare function isNotFound(error: unknown): boolean;
/**
 * Crash-atomic file write: a concurrent reader sees either the complete
 * previous bytes or the complete new bytes, never a torn file. `dir` is created
 * (0700) if absent; the data is written to `tmpPath` (created exclusively,
 * 0600), fsync'd, then atomically renamed onto `finalPath`. A failure at any
 * point removes the temp file and leaves the previous file untouched.
 *
 * `tmpPath` must be a sibling of `finalPath` (same directory) so the rename
 * stays within one filesystem and is therefore atomic, and should carry a
 * random component so concurrent writers (and crash-orphaned leftovers) are
 * collide-free.
 *
 * Durability bar: the temp file is fsync'd before the rename so a power loss
 * cannot surface a file whose bytes never reached the platter, and `dir` is
 * fsync'd afterwards (best-effort — see {@link syncDirBestEffort}) so the
 * rename itself survives a crash. On POSIX `rename(2)` replaces atomically;
 * Node maps to `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` on Windows, which is
 * also atomic — though it can fail with `EPERM`/`EBUSY` if another process
 * holds the destination open. That cross-process case is out of scope for the
 * single-flight in-process callers here; such a failure surfaces to the caller
 * with the previous file left intact.
 */
export declare function writeFileAtomically(dir: string, tmpPath: string, finalPath: string, data: Uint8Array): Promise<void>;
