// The sandbox Mac's "Delete the Mac…" confirm: what is freed (measured on disk, not the disk image's 40 GB sparse size)
// and what is lost. Pure, so a node test covers the wording (macDelete.test.ts).

export const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e11 ? 0 : 1)} GB` : `${Math.max(0, Math.round(b / 1e6))} MB`);

/** The bytes the Mac takes on this computer: the whole folder when the backend measured it, else the disk image's. */
export function macFootprint(s: { vmBytes?: number; diskBytes?: number }): number | null {
  const b = s.vmBytes ?? s.diskBytes;
  return b && b > 0 ? b : null;
}

export function deleteConfirmText(s: { vmBytes?: number; diskBytes?: number }, downloadGb: number): { title: string; body: string; freed: string | null } {
  const b = macFootprint(s);
  return {
    title: "Delete the Mac?",
    freed: b == null ? null : `Frees ${fmtBytes(b)} on this computer.`,
    body: `The Mac's files and the apps installed in it are lost. You can download it again later (about ${downloadGb} GB).`,
  };
}
