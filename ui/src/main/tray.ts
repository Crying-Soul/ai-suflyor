// The app's only always-present handle: overlays skip the taskbar, so without this a hidden
// overlay pair could be found only by hotkey, and there was no way to quit.
import { Menu, Tray, nativeImage } from "electron";

export interface TrayActions {
  toggleWindows(): void;
  openCalls(): void;
  openSettings(section?: string): void;
  togglePreset(): void;
  toggleClickThrough(): void;
  checkUpdates(): void;
  quit(): void;
}

/** A periwinkle dot on a slate disc, drawn in code: no icon file to ship. */
function icon(): Electron.NativeImage {
  const img = nativeImage.createEmpty();
  for (const [size, scale] of [[16, 1], [32, 2]] as const) {
    const buf = Buffer.alloc(size * size * 4);
    const c = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - c, y - c) / (size / 2);
        // BGRA; soft edge over one pixel.
        const edge = (r: number) => Math.max(0, Math.min(1, (r - d) * size * 0.5));
        const outer = edge(1);
        const inner = edge(0.45);
        const mix = (a: number, b: number) => Math.round(a * (1 - inner) + b * inner);
        const i = (y * size + x) * 4;
        buf[i] = mix(0x2a, 0xf0); // B
        buf[i + 1] = mix(0x22, 0xb4); // G
        buf[i + 2] = mix(0x1d, 0xa6); // R
        buf[i + 3] = Math.round(255 * outer);
      }
    }
    img.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: nativeImage.createFromBitmap(buf, { width: size, height: size }).toPNG() });
  }
  return img;
}

export function createTray(a: TrayActions): { setCall(title: string | null): void } {
  const tray = new Tray(icon());
  tray.setToolTip("Суфлёр");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Показать или скрыть окна", click: a.toggleWindows },
      { label: "Звонки", click: a.openCalls },
      { label: "Настройки", click: () => a.openSettings() },
      { label: "Справка", click: () => a.openSettings("guide") },
      { label: "Проверить обновления", click: a.checkUpdates },
      { type: "separator" },
      { label: "«У камеры»", click: a.togglePreset },
      { label: "Клики сквозь окна", click: a.toggleClickThrough },
      { type: "separator" },
      { label: "Выход", click: a.quit },
    ]),
  );
  tray.on("click", a.toggleWindows);
  return { setCall: (title) => tray.setToolTip(title ? `Суфлёр: ${title}` : "Суфлёр") };
}
