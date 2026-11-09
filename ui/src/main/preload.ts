import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { CoreEvent, RendererApi, UiMessage } from "../shared/protocol";

const api: RendererApi = {
  send: (cmd) => ipcRenderer.send("core-cmd", cmd),
  hide: () => ipcRenderer.send("hide"),
  onEvent: (cb) => {
    ipcRenderer.on("core-event", (_e, ev: CoreEvent) => cb(ev));
  },
  openSettings: (section) => ipcRenderer.send("settings:open", section),
  closeWindow: () => ipcRenderer.send("window:close"),
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (patch) => ipcRenderer.invoke("config:save", patch),
  listMics: () => ipcRenderer.invoke("config:mics"),
  openCalls: () => ipcRenderer.send("calls:open"),
  onUi: (cb) => {
    ipcRenderer.on("ui", (_e, m: UiMessage) => cb(m));
  },
  copy: (text) => ipcRenderer.send("ui:copy", text),
  action: (a) => ipcRenderer.send("ui:action", a),
  hotkeys: () => ipcRenderer.invoke("hotkeys:get"),
  calls: {
    tree: () => ipcRenderer.invoke("calls:tree"),
    node: (dir) => ipcRenderer.invoke("calls:node", dir),
    save: (dir, patch) => ipcRenderer.invoke("calls:save", dir, patch),
    createFolder: (title) => ipcRenderer.invoke("calls:create-folder", title),
    createCall: (folder, title) => ipcRenderer.invoke("calls:create-call", folder, title),
    addFiles: (dir, paths) => ipcRenderer.invoke("calls:add-files", dir, paths),
    fileText: (dir, name) => ipcRenderer.invoke("calls:file-text", dir, name),
    removeFile: (dir, name) => ipcRenderer.invoke("calls:remove-file", dir, name),
    remove: (dir) => ipcRenderer.invoke("calls:remove", dir),
    preview: (dir) => ipcRenderer.invoke("calls:preview", dir),
    reveal: (dir) => ipcRenderer.send("calls:reveal", dir),
    current: () => ipcRenderer.invoke("calls:current"),
  },
  ready: {
    list: () => ipcRenderer.invoke("ready:list"),
    open: () => ipcRenderer.send("ready:open"),
    useApiKey: (key) => ipcRenderer.invoke("ready:apiKey", key),
    useClaudeCode: () => ipcRenderer.invoke("ready:claudeCode"),
    getModel: (id) => ipcRenderer.send("ready:model", id),
    openLogs: () => ipcRenderer.send("ready:logs"),
    onChange: (cb) => {
      ipcRenderer.on("ready:changed", (_e, items) => cb(items));
    },
  },
  update: {
    state: () => ipcRenderer.invoke("update:state"),
    check: () => ipcRenderer.send("update:check"),
    download: () => ipcRenderer.send("update:download"),
    install: () => ipcRenderer.send("update:install"),
    onChange: (cb) => {
      ipcRenderer.on("update:changed", (_e, s) => cb(s));
    },
  },
  packs: {
    status: (id) => ipcRenderer.invoke("pack:status", id),
    download: (id) => ipcRenderer.invoke("pack:download", id),
    cancel: (id) => ipcRenderer.send("pack:cancel", id),
  },
  models: {
    list: () => ipcRenderer.invoke("models:list"),
    download: (id) => ipcRenderer.invoke("models:download", id),
    cancel: (id) => ipcRenderer.send("models:cancel", id),
    remove: (id) => ipcRenderer.invoke("models:remove", id),
    use: (id) => ipcRenderer.invoke("models:use", id),
    onChange: (cb) => {
      ipcRenderer.on("models:changed", () => cb());
    },
  },
  privacyTest: () => ipcRenderer.invoke("privacy:test"),
  openLogs: () => ipcRenderer.send("logs:open"),
  pathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld("api", api);
