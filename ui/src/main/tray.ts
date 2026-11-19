// The app's only always-present handle: overlays skip the taskbar, so without this a hidden
// overlay pair could be found only by hotkey, and there was no way to quit.
import { Menu, Tray, nativeImage } from "electron";
import { rasterize } from "../shared/mark";

export interface TrayActions {
  toggleWindows(): void;
  openCalls(): void;
  openSettings(section?: string): void;
  togglePreset(): void;
  toggleClickThrough(): void;
  openReady(): void;
  checkUpdates(): void;
  restartCore(): void;
  quit(): void;
}

/** The app's mark (src/shared/mark.ts) at the given sizes: tray, window and taskbar icons. */
export function markImage(sizes: [size: number, scale: number][] = [[16, 1], [32, 2]]): Electron.NativeImage {
  const img = nativeImage.createEmpty();
  for (const [size, scale] of sizes) {
    const rgba = rasterize(size);
    // createFromBitmap takes BGRA.
    const bgra = Buffer.from(rgba);
    for (let i = 0; i < bgra.length; i += 4) [bgra[i], bgra[i + 2]] = [rgba[i + 2], rgba[i]];
    img.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: nativeImage.createFromBitmap(bgra, { width: size, height: size }).toPNG() });
  }
  return img;
}

export function createTray(a: TrayActions): { setCall(title: string | null): void } {
  const tray = new Tray(markImage());
  tray.setToolTip("Суфлёр");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Показать или скрыть окна", click: a.toggleWindows },
      { label: "Звонки", click: a.openCalls },
      { label: "Настройки", click: () => a.openSettings() },
      { label: "Справка", click: () => a.openSettings("guide") },
      { label: "Проверка готовности", click: a.openReady },
      { label: "Проверить обновления", click: a.checkUpdates },
      { label: "Перезапустить ядро", click: a.restartCore },
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
