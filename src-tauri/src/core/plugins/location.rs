// This PC's position, for Locate: a paired device the user allowed may ask where this machine is
// (link.location.request), mainly to find a lost laptop. Windows works it out from Wi-Fi networks
// nearby, a GPS receiver if one is fitted, or the IP address, so a desktop is usually placed to
// within tens of metres to a few kilometres. Needs Windows' "Location services" and "Let desktop
// apps access your location" switched on. The answers use the same link.location packet as
// Android (LinkLocation.java).

use serde_json::{json, Value};
use std::time::Duration;

/// Why no position could be given; the wire names match Android's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unavailable {
    /// Windows refuses location to desktop apps (Settings, Privacy, Location).
    NoPermission,
    /// Location services are switched off.
    Off,
    /// Nothing answered in time.
    NoFix,
}

impl Unavailable {
    pub fn status(self) -> &'static str {
        match self {
            Unavailable::NoPermission => "noPermission",
            Unavailable::Off => "off",
            Unavailable::NoFix => "unavailable",
        }
    }
}

pub fn status_body(status: &str) -> Value {
    json!({ "status": status })
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator, PositionAccuracy, PositionSource, PositionStatus};
    use windows::Foundation::TimeSpan;

    // Windows' DateTime counts 100 ns ticks from 1601; the Unix epoch is this many ticks later.
    const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;

    fn span(d: Duration) -> TimeSpan {
        TimeSpan { Duration: (d.as_nanos() / 100) as i64 }
    }

    fn ensure_apartment() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        // SAFETY: plain COM call; keeps the multithreaded apartment alive for the process so any
        // thread may use the WinRT location objects (as media.rs does for its session manager).
        ONCE.call_once(|| unsafe {
            let _ = windows::Win32::System::Com::CoIncrementMTAUsage();
        });
    }

    pub fn locate(max_age: Duration, timeout: Duration, precise: bool) -> Result<Value, Unavailable> {
        ensure_apartment();
        let access = Geolocator::RequestAccessAsync().and_then(|op| op.get()).map_err(|_| Unavailable::NoPermission)?;
        if access != GeolocationAccessStatus::Allowed {
            return Err(Unavailable::NoPermission);
        }
        let locator = Geolocator::new().map_err(|_| Unavailable::NoFix)?;
        let _ = locator.SetDesiredAccuracy(if precise { PositionAccuracy::High } else { PositionAccuracy::Default });
        if locator.LocationStatus().is_ok_and(|s| s == PositionStatus::Disabled) {
            return Err(Unavailable::Off);
        }
        let position = locator
            .GetGeopositionAsyncWithAgeAndTimeout(span(max_age), span(timeout))
            .and_then(|op| op.get())
            .map_err(|_| Unavailable::NoFix)?;
        let coordinate = position.Coordinate().map_err(|_| Unavailable::NoFix)?;
        let point = coordinate.Point().and_then(|p| p.Position()).map_err(|_| Unavailable::NoFix)?;
        let time = coordinate.Timestamp().map(|t| (t.UniversalTime - UNIX_EPOCH_TICKS) / 10_000).unwrap_or_else(|_| chrono::Utc::now().timestamp_millis());
        let provider = match coordinate.PositionSource() {
            Ok(PositionSource::Satellite) => "gps",
            Ok(PositionSource::WiFi) | Ok(PositionSource::Cellular) => "network",
            Ok(PositionSource::IPAddress) => "ip",
            _ => "",
        };
        let mut body = json!({
            "status": "fix",
            "latitude": point.Latitude,
            "longitude": point.Longitude,
            "provider": provider,
            "time": time,
            // Taken for this request rather than remembered from earlier.
            "fresh": chrono::Utc::now().timestamp_millis() - time < 60_000,
        });
        if let Ok(accuracy) = coordinate.Accuracy() {
            body["accuracy"] = json!(accuracy);
        }
        if let Some(speed) = coordinate.Speed().ok().and_then(|s| s.Value().ok()).filter(|s| s.is_finite()) {
            body["speed"] = json!(speed);
        }
        Ok(body)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn locate(_max_age: Duration, _timeout: Duration, _precise: bool) -> Result<Value, Unavailable> {
        Err(Unavailable::NoFix)
    }
}

/// One position as a link.location body. `max_age` lets Windows answer with a recent remembered
/// fix instead of finding a new one; blocking, so call it off the async runtime.
pub fn locate(max_age: Duration, timeout: Duration, precise: bool) -> Result<Value, Unavailable> {
    imp::locate(max_age, timeout, precise)
}
