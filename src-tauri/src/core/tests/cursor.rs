// The mouse pointer drawn into captured frames: its shape is recovered from the pointer drawn over
// black and over white, then blended into the frame (BGRA, as captured) at the pointer's position.

use crate::core::cursor::{blend, shape_from, Px, Shape};

fn bgra(b: u8, g: u8, r: u8) -> [u8; 4] {
    [b, g, r, 255]
}

fn pixel(frame: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let at = ((y * width + x) * 4) as usize;
    frame[at..at + 4].try_into().unwrap()
}

#[test]
fn each_kind_of_pointer_pixel_is_recognised() {
    // Pixels: see-through, opaque red, half-transparent black (a shadow), and inverting.
    let black = [bgra(0, 0, 0), bgra(0, 0, 255), bgra(0, 0, 0), bgra(255, 255, 255)].concat();
    let white = [bgra(255, 255, 255), bgra(0, 0, 255), bgra(128, 128, 128), bgra(0, 0, 0)].concat();
    let shape = shape_from(&black, &white, 4, 1, 0, 0);
    assert_eq!(shape.pixels[0], Px::Clear);
    assert_eq!(shape.pixels[1], Px::Paint([255, 0, 0], 255));
    assert_eq!(shape.pixels[2], Px::Paint([0, 0, 0], 127));
    assert_eq!(shape.pixels[3], Px::Invert);
}

#[test]
fn the_pointer_lands_at_its_hotspot_and_stays_inside_the_frame() {
    let mut frame = bgra(30, 20, 10).repeat(16);
    // A 2x2 pointer: red, clear / clear, inverting, with its hotspot on the bottom-right pixel.
    let shape = Shape { width: 2, height: 2, hot_x: 1, hot_y: 1, pixels: vec![Px::Paint([255, 0, 0], 255), Px::Clear, Px::Clear, Px::Invert] };
    blend(&mut frame, 4, 4, &shape, 2, 2);
    assert_eq!(pixel(&frame, 4, 1, 1), bgra(0, 0, 255), "top-left of the pointer, red in BGRA order");
    assert_eq!(pixel(&frame, 4, 2, 1), bgra(30, 20, 10), "clear pixels leave the screen alone");
    assert_eq!(pixel(&frame, 4, 2, 2), bgra(225, 235, 245), "inverting pixel at the hotspot");
    // Half off the frame's edge, and fully outside it: no panic, nothing drawn outside.
    blend(&mut frame, 4, 4, &shape, 0, 0);
    blend(&mut frame, 4, 4, &shape, 100, -50);
    assert_eq!(pixel(&frame, 4, 0, 0), bgra(225, 235, 245));
}
