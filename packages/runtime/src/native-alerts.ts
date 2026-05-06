import type { Node } from "@brna/schema";

type AlertButtonStyle = "default" | "cancel" | "destructive";

interface AlertButtonLike {
  text?: string;
  onPress?: (value?: unknown) => void;
  style?: AlertButtonStyle;
  isPreferred?: boolean;
}

interface AlertOptionsLike {
  cancelable?: boolean;
  onDismiss?: () => void;
}

interface AlertModuleLike {
  alert?: (
    title: string,
    message?: string,
    buttons?: AlertButtonLike[],
    options?: AlertOptionsLike,
  ) => unknown;
}

interface NativeAlertRecord {
  id: string;
  title: string;
  message?: string;
  buttons: Array<{ id: string; text: string; style?: AlertButtonStyle }>;
}

const DEFAULT_BUTTON_TEXT = "OK";
let nextAlertId = 1;
const activeAlerts = new Map<string, NativeAlertRecord>();
const patchedModules = new WeakSet<object>();

export function installNativeAlertTracking(alertModule: AlertModuleLike | undefined): boolean {
  if (!alertModule || typeof alertModule !== "object" || patchedModules.has(alertModule)) return false;
  const original = alertModule.alert;
  if (typeof original !== "function") return false;

  alertModule.alert = function trackedAlert(
    this: unknown,
    title: string,
    message?: string,
    buttons?: AlertButtonLike[],
    options?: AlertOptionsLike,
  ): unknown {
    const record = createNativeAlertRecord(title, message, buttons);
    activeAlerts.set(record.id, record);
    const wrappedButtons = normalizeButtons(buttons).map((button) => ({
      ...button,
      onPress: (value?: unknown) => {
        activeAlerts.delete(record.id);
        button.onPress?.(value);
      },
    }));
    const wrappedOptions = {
      ...(options ?? {}),
      onDismiss: () => {
        activeAlerts.delete(record.id);
        options?.onDismiss?.();
      },
    };

    try {
      return original.call(this, title, message, wrappedButtons, wrappedOptions);
    } catch (err) {
      activeAlerts.delete(record.id);
      throw err;
    }
  };

  patchedModules.add(alertModule);
  return true;
}

export function getNativeAlertOverlays(): Node[] {
  return Array.from(activeAlerts.values()).map((alert) => {
    const children: Node[] = [];
    if (alert.message) {
      children.push({
        id: `${alert.id}-message`,
        kind: "text",
        name: alert.message,
        text: alert.message,
      });
    }
    children.push(
      ...alert.buttons.map((button): Node => ({
        id: button.id,
        kind: "button",
        name: button.text,
        ...(button.style === "cancel" ? { role: "cancel" } : {}),
      })),
    );
    return {
      id: alert.id,
      kind: "modal",
      role: "alert",
      name: alert.title,
      children,
    };
  });
}

export function clearNativeAlertTrackingForTests(): void {
  activeAlerts.clear();
  nextAlertId = 1;
}

function createNativeAlertRecord(
  title: unknown,
  message: unknown,
  buttons: AlertButtonLike[] | undefined,
): NativeAlertRecord {
  const id = `native-alert-${nextAlertId++}`;
  const alertMessage = stringifyAlertText(message);
  return {
    id,
    title: stringifyAlertText(title) ?? "Alert",
    ...(alertMessage ? { message: alertMessage } : {}),
    buttons: normalizeButtons(buttons).map((button, index) => ({
      id: `${id}-button-${index + 1}`,
      text: stringifyAlertText(button.text) ?? DEFAULT_BUTTON_TEXT,
      ...(button.style ? { style: button.style } : {}),
    })),
  };
}

function normalizeButtons(buttons: AlertButtonLike[] | undefined): AlertButtonLike[] {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    return [{ text: DEFAULT_BUTTON_TEXT }];
  }
  return buttons;
}

function stringifyAlertText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}
