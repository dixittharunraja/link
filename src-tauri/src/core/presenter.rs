use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// The red pointer dot a phone drives while presenting: a click-through, always-on-top transparent
// window over the primary display. The overlay page exposes window.__setDot(x, y) with
// fractions of the screen; moves arrive from the UDP input relay and the dot hides itself shortly
// after the last one.

const LABEL: &str = "presenter";
const HIDE_AFTER: Duration = Duration::from_millis(500);
const PAGE_LOAD_GRACE: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct Presenter {
    position: Mutex<Option<(f64, f64)>>,
    // Each move bumps this; a hide timer only fires if no newer move arrived.
    generation: AtomicU64,
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

impl Presenter {
    fn window(&self, app: &AppHandle) -> Option<(WebviewWindow, bool)> {
        if let Some(existing) = app.get_webview_window(LABEL) {
            return Some((existing, false));
        }
        let monitor = app.primary_monitor().ok().flatten()?;
        let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("presenter-overlay.html".into()))
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(false)
            .visible(false)
            .resizable(false)
            .build()
            .ok()?;
        let _ = window.set_position(PhysicalPosition::new(monitor.position().x, monitor.position().y));
        let _ = window.set_size(PhysicalSize::new(monitor.size().width, monitor.size().height));
        let _ = window.set_ignore_cursor_events(true);
        Some((window, true))
    }

    /// Moves the dot by (dx, dy) in screen fractions (dy is scaled by the aspect ratio) and shows it.
    pub async fn move_dot(&'static self, app: AppHandle, dx: f64, dy: f64) {
        let aspect = app
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| m.size().width as f64 / m.size().height.max(1) as f64)
            .unwrap_or(16.0 / 9.0);
        let (x, y) = {
            let Ok(mut pos) = self.position.lock() else { return };
            let (px, py) = pos.unwrap_or((0.5, 0.5));
            let next = (clamp01(px + dx), clamp01(py + dy * aspect));
            *pos = Some(next);
            next
        };
        let Some((window, created)) = self.window(&app) else { return };
        if created {
            tokio::time::sleep(PAGE_LOAD_GRACE).await;
        }
        let _ = window.eval(format!("window.__setDot && window.__setDot({}, {})", x, y));
        let _ = window.show();

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(HIDE_AFTER).await;
            if self.generation.load(Ordering::SeqCst) == generation {
                if let Some(window) = app.get_webview_window(LABEL) {
                    let _ = window.hide();
                }
            }
        });
    }

    /// Presentation ended: close the overlay and forget the dot's position.
    pub fn stop(&self, app: &AppHandle) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut pos) = self.position.lock() {
            *pos = None;
        }
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.close();
        }
    }
}
