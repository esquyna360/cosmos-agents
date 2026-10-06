import { invoke } from "@tauri-apps/api/core";

export interface WebInfo {
  port?: number;
  local?: string;
  lan?: string | null;
  tunnel?: string | null;
  link?: string | null;
  error?: string;
}

export function webInfo(): Promise<WebInfo> {
  return invoke("web_info");
}

export interface RemoteConfig {
  enabled: boolean;
  port: number;
  tunnel: boolean;
  lan: boolean;
  telegram_notify: boolean;
  telegram_chat_id: string;
  telegram_token_file: string;
}

/** Config as stored, plus what the runtime can observe about it. */
export interface RemoteConfigView extends RemoteConfig {
  tunnel_running: boolean;
  cloudflared_present: boolean;
}

export function remoteConfigGet(): Promise<RemoteConfigView> {
  return invoke("remote_config_get");
}

export function remoteConfigSet(config: RemoteConfig): Promise<void> {
  return invoke("remote_config_set", { config });
}

export function appVersion(): Promise<string> {
  return invoke("app_version");
}

/** The code a new browser types to get in. */
export interface PairCode {
  code: string;
  /** Unix seconds. */
  expires: number;
}

/** A browser that was let in. */
export interface WebDevice {
  id: string;
  name: string;
  created: number;
  lastSeen: number;
  expires: number;
  address: string;
  agent: string;
}

export function webPairStart(): Promise<PairCode> {
  return invoke("web_pair_start");
}

export function webPairCurrent(): Promise<PairCode | null> {
  return invoke("web_pair_current");
}

export function webPairCancel(): Promise<void> {
  return invoke("web_pair_cancel");
}

export function webDevices(): Promise<WebDevice[]> {
  return invoke("web_devices");
}

export function webDeviceRevoke(id: string): Promise<boolean> {
  return invoke("web_device_revoke", { id });
}
