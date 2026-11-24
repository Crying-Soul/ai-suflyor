// Rewrites an exe's name and icon resources: what Task Manager shows for a process (Settings → Кастомизация).
// No electron here, so tests load it. resedit comes in as an argument: the bundle needs its CJS build
// (require), the tests its ESM one (import).
import type * as RE from "resedit";

/** A failure with a message for the user. */
export class BrandError extends Error {}

/**
 * `exe` with FileDescription and ProductName set to `name`, and `icon` (.ico bytes) as its first icon
 * group. An exe without a version resource (our Rust core) gets one, else Task Manager shows its file name.
 */
export function patchExe(R: typeof RE, exe: Uint8Array, name: string, icon: Buffer | null): Buffer {
  const nt = R.NtExecutable.from(exe, { ignoreCert: true });
  const res = R.NtExecutableResource.from(nt);
  const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0] ?? R.Resource.VersionInfo.createEmpty();
  const langs = vi.getAllLanguagesForStringValues();
  for (const lang of langs.length ? langs : [{ lang: 1033, codepage: 1200 }]) vi.setStringValues(lang, { FileDescription: name, ProductName: name });
  vi.outputToResourceEntries(res.entries);
  if (icon) {
    let file: RE.Data.IconFile;
    try {
      file = R.Data.IconFile.from(icon);
    } catch {
      throw new BrandError("Файл значка повреждён.");
    }
    const [group] = R.Resource.IconGroupEntry.fromEntries(res.entries);
    R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group?.id ?? 1, group?.lang ?? 1033, file.icons.map((i) => i.data));
  }
  res.outputResource(nt);
  return Buffer.from(nt.generate());
}
