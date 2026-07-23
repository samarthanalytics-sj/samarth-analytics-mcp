import { BrowserWindow, Notification, ipcMain } from 'electron';
import { notificationText, shouldNotify, type TaskResultSummary } from '../../shared/task-notification';

// Desktop notification when a long-running task finishes. The renderer reports WHAT happened; the
// decision to show anything, and the wording, come from shared/task-notification so both are
// testable without an OS notification centre.
//
// Focus is read HERE rather than in the renderer: document.hasFocus() is true whenever the page has
// focus within its own window, which stays true when that window is behind another app. The only
// authority on "is the user actually looking at this" is the OS-level window state.

/** Whether the app currently has the user's attention: a visible, focused, non-minimised window. */
function appIsFocused(): boolean {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return false;
  return win.isFocused() && win.isVisible() && !win.isMinimized();
}

export function registerNotifyIpc(): void {
  /**
   * Fire a completion notification if this task earns one. Returns whether one was shown, so the
   * renderer can tell the difference between "suppressed" and "failed" without guessing.
   *
   * Best-effort throughout: notifications are a courtesy, and a platform that refuses them (Windows
   * focus assist, a Linux box with no notification daemon, permissions withheld on macOS) must never
   * turn a finished scan into an error.
   */
  ipcMain.handle('notify:taskDone', (_event, summary: TaskResultSummary): boolean => {
    try {
      if (!summary || typeof summary !== 'object' || typeof summary.task !== 'string') return false;
      if (!Notification.isSupported()) return false;
      if (!shouldNotify(summary, appIsFocused())) return false;

      const { title, body } = notificationText(summary);
      const n = new Notification({ title, body, silent: false });
      // Clicking it is a request to come back and look, so raise the window rather than only
      // dismissing the toast.
      n.on('click', () => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      });
      n.show();
      return true;
    } catch (e) {
      console.error('[notify] could not show a notification (continuing):', e instanceof Error ? e.message : e);
      return false;
    }
  });
}
