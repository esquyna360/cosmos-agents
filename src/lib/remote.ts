import { invoke } from "@tauri-apps/api/core";

export interface WebInfo {
  port?: number;
  token?: string;
  local?: string;
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
