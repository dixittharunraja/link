// Draws the mouse pointer into a captured screen image. Screen capture copies the desktop's pixels,
// and Windows draws the pointer separately on top, so without this a viewer (a phone used as a
// second screen, or remote control) sees no pointer even while the PC's own mouse is moving there.
//
// The pointer's shape is rendered once per pointer type: drawn over black and over white, the two
// results give each pixel's colour and transparency, and show which pixels invert what is under them
// (the text I-beam does that). Shapes are kept, so a frame only costs one lookup and a small blend,
// and the pixels under the pointer are kept too, so it can be moved without redrawing the frame.

use std::collections::HashMap;
use std::sync::Mutex;

/// One pixel of a pointer shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Px {
    Clear,
    /// Colour and opacity (0..=255).
    Paint([u8; 3], u8),
    /// Inverts the screen pixel under it.
    Invert,
}

#[derive(Clone, Debug)]
pub struct Shape {
    pub width: u32,
    pub height: u32,
    pub hot_x: i32,
    pub hot_y: i32,
    pub pixels: Vec<Px>,
}

/// Works out a shape from the same pointer drawn over black and over white (both BGRA, top-down).
pub fn shape_from(black: &[u8], white: &[u8], width: u32, height: u32, hot_x: i32, hot_y: i32) -> Shape {
    let pixels = black
        .chunks_exact(4)
        .zip(white.chunks_exact(4))
        .take((width * height) as usize)
        .map(|(b, w)| {
            let (bb, bg, br) = (b[0] as i32, b[1] as i32, b[2] as i32);
            let (wb, wg, wr) = (w[0] as i32, w[1] as i32, w[2] as i32);
            // Darker over white than over black: the pixel inverts what is under it.
            if wb + wg + wr + 60 < bb + bg + br {
                return Px::Invert;
            }
            // Over black a pixel shows colour * alpha; over white it shows that plus (1 - alpha) * white.
            let alpha = (255 - ((wb - bb) + (wg - bg) + (wr - br)) / 3).clamp(0, 255);
            if alpha < 8 {
                return Px::Clear;
            }
            let un = |c: i32| ((c * 255 + alpha / 2) / alpha).clamp(0, 255) as u8;
            Px::Paint([un(br), un(bg), un(bb)], alpha as u8)
        })
        .collect();
    Shape { width, height, hot_x, hot_y, pixels }
}

/// The part of a `width` x `height` frame a shape covers with its hotspot at (x, y), as
/// (left, top, right, bottom) in frame pixels, or None when it is entirely outside.
fn covered(shape: &Shape, width: u32, height: u32, x: i32, y: i32) -> Option<(u32, u32, u32, u32)> {
    let (left, top) = (x - shape.hot_x, y - shape.hot_y);
    let (l, t) = (left.max(0), top.max(0));
    let (r, b) = ((left + shape.width as i32).min(width as i32), (top + shape.height as i32).min(height as i32));
    (l < r && t < b).then_some((l as u32, t as u32, r as u32, b as u32))
}

/// Blends a shape into a BGRA frame (`width` pixels a row) with its hotspot at (x, y) in frame pixels.
pub fn blend(bgra: &mut [u8], width: u32, height: u32, shape: &Shape, x: i32, y: i32) {
    let Some((l, t, r, b)) = covered(shape, width, height, x, y) else { return };
    let (left, top) = (x - shape.hot_x, y - shape.hot_y);
    for py in t..b {
        let sy = (py as i32 - top) as u32;
        for px in l..r {
            let sx = (px as i32 - left) as u32;
            let at = ((py * width + px) * 4) as usize;
            let dst = &mut bgra[at..at + 3];
            match shape.pixels[(sy * shape.width + sx) as usize] {
                Px::Clear => {}
                Px::Invert => {
                    for c in dst.iter_mut() {
                        *c = 255 - *c;
                    }
                }
                Px::Paint([red, green, blue], a) => {
                    let a = a as u32;
                    for (c, value) in dst.iter_mut().zip([blue, green, red]) {
                        *c = ((value as u32 * a + *c as u32 * (255 - a) + 127) / 255) as u8;
                    }
                }
            }
        }
    }
}

// Rendered shapes by pointer handle. Pointer types are few (arrow, hand, I-beam, resize...).
static SHAPES: Mutex<Option<HashMap<usize, Shape>>> = Mutex::new(None);

fn with_shape<T>(handle: usize, f: impl FnOnce(&Shape) -> T) -> Option<T> {
    let mut cache = SHAPES.lock().ok()?;
    let shapes = cache.get_or_insert_with(HashMap::new);
    if !shapes.contains_key(&handle) {
        let shape = win::render(handle)?;
        if shapes.len() > 32 {
            shapes.clear();
        }
        shapes.insert(handle, shape);
    }
    shapes.get(&handle).map(f)
}

/// The visible pointer's handle and desktop position, or None while it is hidden.
pub fn current() -> Option<(usize, i32, i32)> {
    win::current()
}

/// A pointer drawn into a frame, and the pixels it covered, so the frame can be kept and the
/// pointer moved by putting those pixels back and drawing it again, instead of copying the whole
/// frame each time the pointer moves.
#[derive(Default)]
pub struct Drawn {
    /// The pointer (handle and desktop position) as drawn, None when nothing is drawn.
    at: Option<(usize, i32, i32)>,
    /// (left, top, right, bottom) of the covered pixels, and the pixels themselves, row by row.
    area: (u32, u32, u32, u32),
    saved: Vec<u8>,
}

impl Drawn {
    /// True when `pointer` is what is already drawn (or nothing is, and there is none to draw).
    pub fn shows(&self, pointer: Option<(usize, i32, i32)>) -> bool {
        self.at == pointer
    }

    /// Drops what is drawn without restoring it, for when the whole frame was replaced anyway.
    pub fn forget(&mut self) {
        self.at = None;
    }

    /// Puts back the pixels under the pointer; returns the rows that changed.
    pub fn erase(&mut self, bgra: &mut [u8], width: u32) -> Option<std::ops::Range<u32>> {
        self.at.take()?;
        let (l, t, r, b) = self.area;
        let row = ((r - l) * 4) as usize;
        for (y, saved) in (t..b).zip(self.saved.chunks_exact(row)) {
            let at = ((y * width + l) * 4) as usize;
            bgra[at..at + row].copy_from_slice(saved);
        }
        Some(t..b)
    }

    /// Draws `pointer` (from [`current`]) into a BGRA frame of a monitor whose top-left corner is at
    /// `origin` on the desktop, keeping what it covers. Erase the previous one first. Returns the
    /// rows that changed; nothing is drawn when the pointer is hidden or on another monitor.
    pub fn draw(&mut self, bgra: &mut [u8], width: u32, height: u32, origin: (i32, i32), pointer: Option<(usize, i32, i32)>) -> Option<std::ops::Range<u32>> {
        debug_assert!(self.at.is_none(), "erase the pointer before drawing it again");
        let (handle, x, y) = pointer?;
        let (x, y) = (x - origin.0, y - origin.1);
        with_shape(handle, |shape| {
            let (l, t, r, b) = covered(shape, width, height, x, y)?;
            self.saved.clear();
            for py in t..b {
                let at = ((py * width + l) * 4) as usize;
                self.saved.extend_from_slice(&bgra[at..at + ((r - l) * 4) as usize]);
            }
            blend(bgra, width, height, shape, x, y);
            self.area = (l, t, r, b);
            self.at = pointer;
            Some(t..b)
        })
        .flatten()
    }
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, CreateSolidBrush, DeleteDC, DeleteObject, FillRect, GdiFlush, GetDC, GetObjectW,
        ReleaseDC, SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, ICONINFO};

    use super::{shape_from, Shape};

    /// The visible pointer's handle and desktop position.
    pub fn current() -> Option<(usize, i32, i32)> {
        unsafe {
            let mut info: CURSORINFO = zeroed();
            info.cbSize = size_of::<CURSORINFO>() as u32;
            if GetCursorInfo(&mut info) == 0 || info.flags & CURSOR_SHOWING == 0 || info.hCursor.is_null() {
                return None;
            }
            Some((info.hCursor as usize, info.ptScreenPos.x, info.ptScreenPos.y))
        }
    }

    pub fn render(handle: usize) -> Option<Shape> {
        unsafe {
            let cursor = handle as *mut c_void;
            let mut icon: ICONINFO = zeroed();
            if GetIconInfo(cursor, &mut icon) == 0 {
                return None;
            }
            let mut bm: BITMAP = zeroed();
            let (width, height) = if !icon.hbmColor.is_null() {
                GetObjectW(icon.hbmColor, size_of::<BITMAP>() as i32, &mut bm as *mut _ as *mut c_void);
                (bm.bmWidth, bm.bmHeight)
            } else {
                // A black-and-white pointer keeps its AND and XOR masks stacked in one bitmap.
                GetObjectW(icon.hbmMask, size_of::<BITMAP>() as i32, &mut bm as *mut _ as *mut c_void);
                (bm.bmWidth, bm.bmHeight / 2)
            };
            if !icon.hbmColor.is_null() {
                DeleteObject(icon.hbmColor);
            }
            if !icon.hbmMask.is_null() {
                DeleteObject(icon.hbmMask);
            }
            if width <= 0 || height <= 0 || width > 256 || height > 256 {
                return None;
            }
            let black = draw(cursor, width, height, 0x000000)?;
            let white = draw(cursor, width, height, 0xFFFFFF)?;
            Some(shape_from(&black, &white, width as u32, height as u32, icon.xHotspot as i32, icon.yHotspot as i32))
        }
    }

    /// The pointer drawn over a solid background, as top-down BGRA.
    fn draw(cursor: *mut c_void, width: i32, height: i32, background: u32) -> Option<Vec<u8>> {
        unsafe {
            let screen = GetDC(null_mut());
            let dc = CreateCompatibleDC(screen);
            let mut info: BITMAPINFO = zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..zeroed()
            };
            let mut bits: *mut c_void = null_mut();
            let dib = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
            let result = if dib.is_null() || bits.is_null() {
                None
            } else {
                let old = SelectObject(dc, dib);
                let brush = CreateSolidBrush(background);
                FillRect(dc, &RECT { left: 0, top: 0, right: width, bottom: height }, brush);
                DeleteObject(brush);
                DrawIconEx(dc, 0, 0, cursor, width, height, 0, null_mut(), DI_NORMAL);
                GdiFlush();
                let pixels = std::slice::from_raw_parts(bits as *const u8, (width * height * 4) as usize).to_vec();
                SelectObject(dc, old);
                Some(pixels)
            };
            if !dib.is_null() {
                DeleteObject(dib);
            }
            DeleteDC(dc);
            ReleaseDC(null_mut(), screen);
            result
        }
    }
}

#[cfg(not(windows))]
mod win {
    pub fn current() -> Option<(usize, i32, i32)> {
        None
    }
    pub fn render(_handle: usize) -> Option<super::Shape> {
        None
    }
}
