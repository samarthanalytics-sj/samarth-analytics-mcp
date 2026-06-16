import { contextBridge, ipcRenderer } from 'electron';
import type { AccountView, AddAccountInput, LlmProvider, SecretSelfTest } from '../shared/ipc';

// The ONLY surface the renderer can reach in the main process. Every capability
// is an explicit, typed method — never raw ipcRenderer. Each phase adds a
// namespace here: Phase 1 → accounts + secrets; later → google (OAuth), mcp
// (tool calls), llm (chat).
const api = {
  getInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:getInfo'),
  ping: (message: string): Promise<string> => ipcRenderer.invoke('app:ping', message),

  accounts: {
    list: (): Promise<AccountView[]> => ipcRenderer.invoke('accounts:list'),
    getActive: (): Promise<AccountView | null> => ipcRenderer.invoke('accounts:getActive'),
    add: (input: AddAccountInput): Promise<AccountView> => ipcRenderer.invoke('accounts:add', input),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('accounts:remove', id),
    setActive: (id: string): Promise<void> => ipcRenderer.invoke('accounts:setActive', id),
    setLlmConfig: (id: string, provider: LlmProvider, model: string): Promise<AccountView> =>
      ipcRenderer.invoke('accounts:setLlmConfig', id, provider, model),
    setLlmApiKey: (id: string, apiKey: string): Promise<AccountView> =>
      ipcRenderer.invoke('accounts:setLlmApiKey', id, apiKey),
  },

  secrets: {
    available: (): Promise<boolean> => ipcRenderer.invoke('secrets:available'),
    selfTest: (): Promise<SecretSelfTest> => ipcRenderer.invoke('secrets:selfTest'),
  },
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
