import { afterEach, describe, expect, test } from "bun:test";
import {
  clearNativeAlertTrackingForTests,
  getNativeAlertOverlays,
  installNativeAlertTracking,
} from "../src/native-alerts.js";

afterEach(() => {
  clearNativeAlertTrackingForTests();
});

describe("native Alert tracking", () => {
  test("records active Alert.alert content as a modal overlay", () => {
    const calls: unknown[][] = [];
    const Alert = {
      alert(...args: unknown[]) {
        calls.push(args);
      },
    };

    expect(installNativeAlertTracking(Alert)).toBe(true);
    Alert.alert("Discard draft?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Discard", style: "destructive" },
    ]);

    expect(calls).toHaveLength(1);
    expect(getNativeAlertOverlays()).toEqual([
      {
        id: "native-alert-1",
        kind: "modal",
        role: "alert",
        name: "Discard draft?",
        children: [
          {
            id: "native-alert-1-message",
            kind: "text",
            name: "This cannot be undone.",
            text: "This cannot be undone.",
          },
          {
            id: "native-alert-1-button-1",
            kind: "button",
            name: "Cancel",
            role: "cancel",
          },
          {
            id: "native-alert-1-button-2",
            kind: "button",
            name: "Discard",
          },
        ],
      },
    ]);
  });

  test("clears active overlay when a wrapped button fires", () => {
    let pressed = false;
    let wrappedButtons: Array<{ onPress?: () => void }> = [];
    const Alert = {
      alert(_title: string, _message?: string, buttons?: Array<{ onPress?: () => void }>) {
        wrappedButtons = buttons ?? [];
      },
    };

    installNativeAlertTracking(Alert);
    Alert.alert("Delete item?", undefined, [{ text: "Delete", onPress: () => { pressed = true; } }]);
    expect(getNativeAlertOverlays()).toHaveLength(1);

    wrappedButtons[0]!.onPress?.();

    expect(pressed).toBe(true);
    expect(getNativeAlertOverlays()).toEqual([]);
  });

  test("uses a default OK button when React Native would create one", () => {
    let wrappedButtons: Array<{ text?: string; onPress?: () => void }> = [];
    const Alert = {
      alert(_title: string, _message?: string, buttons?: Array<{ text?: string; onPress?: () => void }>) {
        wrappedButtons = buttons ?? [];
      },
    };

    installNativeAlertTracking(Alert);
    Alert.alert("Saved");

    expect(getNativeAlertOverlays()[0]?.children?.[0]).toEqual({
      id: "native-alert-1-button-1",
      kind: "button",
      name: "OK",
    });
    expect(wrappedButtons[0]?.text).toBe("OK");
    wrappedButtons[0]?.onPress?.();
    expect(getNativeAlertOverlays()).toEqual([]);
  });

  test("clears active overlay when Android dismisses the dialog", () => {
    let onDismiss: (() => void) | undefined;
    let dismissed = false;
    const Alert = {
      alert(_title: string, _message?: string, _buttons?: unknown[], options?: { onDismiss?: () => void }) {
        onDismiss = options?.onDismiss;
      },
    };

    installNativeAlertTracking(Alert);
    Alert.alert("Heads up", undefined, undefined, { onDismiss: () => { dismissed = true; } });
    expect(getNativeAlertOverlays()).toHaveLength(1);

    onDismiss?.();

    expect(dismissed).toBe(true);
    expect(getNativeAlertOverlays()).toEqual([]);
  });
});
