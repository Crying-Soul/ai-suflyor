// App customization (Settings → Кастомизация): checks for the custom name and icon, shared by main and Settings.

export const NAME_MAX = 64;
export const ICON_MAX_BYTES = 1 << 20;
/** Task Manager and Explorer scale from this size; smaller looks blurry. */
export const ICON_MIN_PX = 32;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Why `name` cannot be the app's name (it is also the exe's file name), or null. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Введите имя";
  if (n.length > NAME_MAX) return `Не длиннее ${NAME_MAX} символов`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(n)) return 'Нельзя использовать < > : " / \\ | ? * и управляющие символы';
  if (/[. ]$/.test(n)) return "Имя не может заканчиваться точкой";
  if (RESERVED.test(n.split(".")[0].trim())) return "Это имя зарезервировано Windows";
  return null;
}

export function iconKind(b: Uint8Array): "ico" | "png" | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "ico";
  return null;
}

/** Why an .ico file cannot be the app icon, or null. Checks the header and that every image lies inside the file. */
export function icoProblem(b: Buffer): string | null {
  if (b.length > ICON_MAX_BYTES) return "Файл больше 1 МБ";
  if (iconKind(b) !== "ico") return "Это не файл .ico";
  const count = b.readUInt16LE(4);
  if (count === 0 || b.length < 6 + 16 * count) return "Файл .ico повреждён";
  let largest = 0;
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const size = b.readUInt32LE(e + 8);
    const offset = b.readUInt32LE(e + 12);
    if (size === 0 || offset + size > b.length) return "Файл .ico повреждён";
    largest = Math.max(largest, b[e] || 256);
  }
  if (largest < ICON_MIN_PX) return `Нужно изображение не меньше ${ICON_MIN_PX}×${ICON_MIN_PX}`;
  return null;
}

/** Why a PNG of this size cannot be the app icon, or null. */
export function pngProblem(bytes: number, width: number, height: number): string | null {
  if (bytes > ICON_MAX_BYTES) return "Файл больше 1 МБ";
  if (!width || !height) return "Файл повреждён или это не изображение";
  if (width !== height) return `Значок должен быть квадратным (сейчас ${width}×${height})`;
  if (width < ICON_MIN_PX) return `Нужно изображение не меньше ${ICON_MIN_PX}×${ICON_MIN_PX}`;
  return null;
}

/** The icon sizes cut from a square PNG of `px`. */
export const icoSizes = (px: number) => [16, 24, 32, 48, 64, 128, 256].filter((s) => s <= px);

/** A ready name with the icon of a standard Windows program (Settings → Кастомизация). */
export interface Preset {
  id: string;
  name: string;
  /** The program in System32 whose icon it takes. */
  exe: string;
}

export const PRESETS: Preset[] = [
  { id: "notepad", name: "Блокнот", exe: "notepad.exe" },
  { id: "calc", name: "Калькулятор", exe: "calc.exe" },
  { id: "control", name: "Панель управления", exe: "control.exe" },
  { id: "msinfo", name: "Сведения о системе", exe: "msinfo32.exe" },
  { id: "resmon", name: "Монитор ресурсов", exe: "resmon.exe" },
  { id: "cleanmgr", name: "Очистка диска", exe: "cleanmgr.exe" },
  { id: "charmap", name: "Таблица символов", exe: "charmap.exe" },
  { id: "osk", name: "Экранная клавиатура", exe: "osk.exe" },
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id);

/** The `icon` value that means a preset's icon (apply / Settings). */
export const PRESET_ICON = "preset:";
