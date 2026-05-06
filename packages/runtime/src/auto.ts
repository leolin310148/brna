import { Alert, AppState, NativeModules } from "react-native";
import { connectAgent } from "./bridge.js";
import { installNativeAlertTracking } from "./native-alerts.js";
import { installObservability } from "./observability.js";

function inferMetroUrl(): string | null {
  const SourceCode = (NativeModules as Record<string, unknown>).SourceCode as
    | { getConstants?: () => { scriptURL?: string } }
    | undefined;
  const scriptURL = SourceCode?.getConstants?.().scriptURL;
  if (typeof scriptURL !== "string" || scriptURL.length === 0) return null;
  try {
    const u = new URL(scriptURL);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

const isDev = (globalThis as { __DEV__?: boolean }).__DEV__ === true;

if (isDev) {
  try {
    installObservability();
  } catch {
    /* never throw from auto-entry */
  }
  try {
    installNativeAlertTracking(Alert);
  } catch {
    /* never throw from auto-entry */
  }
  const metroUrl = inferMetroUrl();
  if (metroUrl) {
    try {
      connectAgent({ metroUrl });
      AppState.addEventListener("change", (state) => {
        if (state === "active") {
          connectAgent({ metroUrl });
        }
      });
    } catch {
      /* never throw from auto-entry */
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn("[brna] could not infer Metro URL from NativeModules.SourceCode.scriptURL — bridge not connected");
  }
}
