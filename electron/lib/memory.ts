/**
 * How much heap the panel's server process gets (`--max-old-space-size`).
 *
 * Pure, so a test can hold the numbers. The shell passes it the PC's total RAM
 * in MB, which panel it hosts and `process.arch`.
 *
 * The Office gets 40% of RAM and the Master up to 60%, and the heap is 70% of
 * that share; the rest is left for PostgreSQL buffers and overhead. The result
 * is then held between a floor and a ceiling:
 *
 *  - The floor is 2048 MB. On a 4 GB PC the share alone came to about
 *    1720 MB, below Node's own default and an out-of-memory risk. The Master
 *    keeps 2048 MB everywhere, because a backup restore still buffers up to
 *    1 GB. The Office, whose live set is small, drops to 1024 MB on a PC with
 *    4.5 GB or less, where every MB the heap may grow into is one the window
 *    and Windows do not get.
 *  - The ceiling is 4096 MB, Node's default. On a 64 GB PC the share came to
 *    about 26 GB, which V8 never uses.
 *  - A 32-bit (`ia32`) process has 2 GB of address space in all, so there the
 *    ceiling is 1024 MB. Only the Windows 7 Office build ships for ia32.
 */

const MB_PER_GB = 1024;
/** 4.5 GB: at or below this a PC counts as small. */
const SMALL_PC_MB = 4.5 * MB_PER_GB;

export function serverHeapMb(totalMb: number, panel: 'master' | 'office', arch: string): number {
  const shareMb = Math.round(totalMb * (panel === 'office' ? 0.4 : 0.6));
  const floor = panel === 'office' && totalMb <= SMALL_PC_MB ? 1024 : 2048;
  const ceiling = arch === 'ia32' ? 1024 : 4096;
  return Math.min(ceiling, Math.max(floor, Math.round(shareMb * 0.7)));
}
