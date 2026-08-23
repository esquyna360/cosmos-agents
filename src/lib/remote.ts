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
