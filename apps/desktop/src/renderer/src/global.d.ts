import type { DawApi } from "../../preload/index";

declare global {
  interface Window {
    daw: DawApi;
  }
}
export {};
