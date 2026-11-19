// Remote control input from a viewer is turned into the one-line commands the input injector runs. Only
// the known actions may produce commands; anything else must produce nothing.

use serde_json::json;

use crate::core::host::remote_control_lines as lines;

#[test]
fn a_tap_moves_to_the_point_then_clicks() {
    assert_eq!(lines(&json!({ "action": "tap", "x": 0.25, "y": 0.75 })), ["abs 0.25 0.75", "click left"]);
    assert_eq!(lines(&json!({ "action": "click", "x": 0.5, "y": 0.5, "button": "right" })), ["abs 0.5 0.5", "click right"]);
}

#[test]
fn a_tap_without_coordinates_goes_to_the_centre() {
    assert_eq!(lines(&json!({ "action": "tap" })), ["abs 0.5 0.5", "click left"]);
}

#[test]
fn a_swipe_scrolls_what_is_under_the_finger_and_the_content_follows_it() {
    // The pointer first goes to where the finger started, because the wheel scrolls what is under it.
    // Six notches per full screen height. A finger moving up (endY < startY) gives a negative wheel
    // delta, which scrolls the page down, as on a touchscreen.
    let up = lines(&json!({ "action": "swipe", "startX": 0.3, "startY": 0.8, "endY": 0.2 }));
    assert_eq!(up.len(), 2);
    assert_eq!(up[0], "abs 0.3 0.8");
    let delta: f64 = up[1].strip_prefix("scroll 0 ").unwrap().parse().unwrap();
    assert!((delta + 3.6).abs() < 1e-9, "unexpected delta {delta}");
    let down = lines(&json!({ "action": "scroll", "startY": 0.2, "endY": 0.8 }));
    assert_eq!(down[0], "abs 0.5 0.2", "a missing x is the middle of the screen");
    let delta: f64 = down[1].strip_prefix("scroll 0 ").unwrap().parse().unwrap();
    assert!((delta - 3.6).abs() < 1e-9, "unexpected delta {delta}");
}

#[test]
fn text_is_sent_as_utf16_units_so_any_character_can_be_typed() {
    assert_eq!(lines(&json!({ "action": "text", "text": "Hi" })), ["unicode 72", "unicode 105"]);
    // An emoji outside the basic plane is two UTF-16 units (a surrogate pair).
    assert_eq!(lines(&json!({ "action": "text", "text": "😀" })), ["unicode 55357", "unicode 56832"]);
}

#[test]
fn only_known_keys_are_mapped() {
    assert_eq!(lines(&json!({ "action": "key", "key": "BACKSPACE" })), ["special 1"]);
    assert_eq!(lines(&json!({ "action": "key", "key": "ENTER" })), ["special 12"]);
    assert_eq!(lines(&json!({ "action": "key", "key": "BACK" })), ["special 14"]);
    assert!(lines(&json!({ "action": "key", "key": "DELETE_EVERYTHING" })).is_empty());
}

#[test]
fn unknown_or_malformed_input_produces_no_commands() {
    assert!(lines(&json!({ "action": "format_disk" })).is_empty());
    assert!(lines(&json!({ "action": "text" })).is_empty(), "text without text");
    assert!(lines(&json!({})).is_empty());
    assert!(lines(&json!(null)).is_empty());
}

#[test]
fn a_second_screen_request_is_told_apart_from_remote_control() {
    use crate::core::rtc_share::Display;
    assert_eq!(Display::from_request(&json!({ "type": "request" })), Display::Primary);
    assert_eq!(Display::from_request(&json!({ "type": "request", "display": "extended" })), Display::Extended);
    assert_eq!(Display::from_request(&json!({ "type": "request", "display": "something" })), Display::Primary);
}

#[test]
fn taps_on_the_second_screen_land_on_that_monitor() {
    use crate::core::host::place_on_monitor;
    use crate::core::rtc_share::Rect;
    // A 1280x720 second screen to the right of a 1920-wide main screen.
    let monitor = Some(Rect { x: 1920, y: 0, width: 1280, height: 720 });
    assert_eq!(place_on_monitor("abs 0 0".into(), monitor), "setpos 1920 0");
    assert_eq!(place_on_monitor("abs 1 1".into(), monitor), "setpos 3199 719");
    assert_eq!(place_on_monitor("abs 0.5 0.5".into(), monitor), "setpos 2560 360");
    assert_eq!(place_on_monitor("abs 2 -1".into(), monitor), "setpos 3199 0", "positions outside the screen are kept on it");
    // A screen to the left of the main one has negative desktop coordinates.
    assert_eq!(place_on_monitor("abs 0 0".into(), Some(Rect { x: -1280, y: 0, width: 1280, height: 720 })), "setpos -1280 0");
    assert_eq!(place_on_monitor("click left".into(), monitor), "click left", "only positions move");
    assert_eq!(place_on_monitor("abs 0.5 0.5".into(), None), "abs 0.5 0.5", "remote control of the main screen is unchanged");
}

#[test]
fn portrait_screens_keep_the_same_detail_as_landscape_ones() {
    use crate::core::rtc_share::fit_scale;
    assert_eq!(fit_scale(1920, 1080), 1.0, "full HD landscape fits as it is");
    assert_eq!(fit_scale(1080, 1920), 1.0, "and so does full HD portrait");
    assert_eq!(fit_scale(3840, 2160), 0.5, "4K is halved");
    assert_eq!(fit_scale(2160, 3840), 0.5, "4K portrait too");
    assert_eq!(fit_scale(1280, 720), 1.0, "smaller screens are never enlarged");
}
