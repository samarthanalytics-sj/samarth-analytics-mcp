import { contextBridge, ipcRenderer } from 'electron';

// The ONLY surface the renderer can reach in the main process. Every capability
// added in later phases (accounts, secrets, MCP tool calls, LLM chat) is added
// here as an explicit, typed method — never by exposing ipcRenderer directly.
const api = {
  getInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:getInfo'),
  ping: (message: string): Promise<string> => ipcRenderer.invoke('app:ping', message),
};

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld('desktop', api);
