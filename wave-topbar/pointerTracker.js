import GLib from 'gi://GLib';

/**
 * PointerTracker: low-level hardware cursor position tracking for GNOME Shell 45+
 * Uses Meta.CursorTracker's 'position-invalidated' signal and throttles callbacks.
 */
export class PointerTracker {
    /**
     * @param {number} intervalMs - minimum interval between callbacks in ms
     * @param {(x: number, y: number) => void} callback
     */
    constructor(intervalMs, callback) {
        this._intervalMs = intervalMs;
        this._callback = callback;
        this._timeoutId = 0;
        this._pending = false;

        this._tracker = global.backend.get_cursor_tracker();
        this._tracker.connectObject(
            'position-invalidated',
            () => this._onPositionInvalidated(),
            this
        );
    }

    _onPositionInvalidated() {
        if (this._timeoutId) {
            this._pending = true;
            return;
        }

        this._emit();
        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this._intervalMs,
            () => {
                this._timeoutId = 0;
                if (this._pending) {
                    this._pending = false;
                    this._emit();
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _emit() {
        const [x, y] = global.get_pointer();
        this._callback?.(x, y);
    }

    destroy() {
        this._tracker?.disconnectObject(this);
        this._tracker = null;
        this._callback = null;
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }
}
