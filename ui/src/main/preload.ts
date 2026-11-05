import { contextBridge, ipcRenderer } from "electron";
import type { CoreEvent, RendererApi } from "../shared/protocol";

const api: RendererApi = {
  send: (cmd) => ipcRenderer.send("core-cmd", cmd),
  hide: () => ipcRenderer.send("hide"),
  onEvent: (cb) => {
    ipcRenderer.on("core-event", (_e, ev: CoreEvent) => cb(ev));
  },
  openSettings: () => ipcRenderer.send("settings:open"),
  closeWindow: () => ipcRenderer.send("window:close"),
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (patch) => ipcRenderer.invoke("config:save", patch),
  listMics: () => ipcRenderer.invoke("config:mics"),
};

contextBridge.exposeInMainWorld("api", api);
