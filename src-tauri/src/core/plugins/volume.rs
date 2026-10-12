// Playback-device volume and mute through the Windows Core Audio endpoint API. Each call runs on
// a blocking thread because COM must be initialised on the thread that uses it.

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Sink {
    pub id: String,
    pub name: String,
    pub volume: u32,
    pub muted: bool,
}

#[cfg(windows)]
mod imp {
    use super::Sink;
    use windows::core::{Result, PCWSTR};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eRender, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};
    
    pub fn enumerator() -> Result<IMMDeviceEnumerator> {
        // SAFETY: plain COM calls; CoInitializeEx fails harmlessly when this thread already
        // initialised COM in another mode.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
        }
    }

    fn read(device: &IMMDevice) -> Result<Sink> {
        // SAFETY: `device` is a live COM interface; the id string is freed exactly once.
        unsafe {
            let id = device.GetId()?;
            let id_string = id.to_string().unwrap_or_default();
            CoTaskMemFree(Some(id.0 as _));

            let store = device.OpenPropertyStore(STGM_READ)?;
            let name = store.GetValue(&PKEY_Device_FriendlyName)?.to_string();

            let endpoint: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
            let volume = (endpoint.GetMasterVolumeLevelScalar()? * 100.0).round() as u32;
            let muted = endpoint.GetMute()?.as_bool();
            Ok(Sink { id: id_string, name, volume, muted })
        }
    }

    pub fn list() -> Vec<Sink> {
        (|| -> Result<Vec<Sink>> {
            // SAFETY: enumeration over a live collection, indices bounded by GetCount.
            let devices = unsafe { enumerator()?.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)? };
            (0..unsafe { devices.GetCount()? }).map(|i| read(&unsafe { devices.Item(i)? })).collect()
        })()
        .unwrap_or_default()
    }

    fn with_endpoint(id: &str, apply: impl FnOnce(&IAudioEndpointVolume) -> Result<()>) -> bool {
        (|| -> Result<()> {
            let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: `wide` is NUL-terminated and outlives the call.
            let endpoint: IAudioEndpointVolume = unsafe {
                enumerator()?.GetDevice(PCWSTR(wide.as_ptr()))?.Activate(CLSCTX_ALL, None)?
            };
            apply(&endpoint)
        })()
        .is_ok()
    }

    pub fn set_volume(id: &str, percent: u32) -> bool {
        let scalar = percent.min(100) as f32 / 100.0;
        // SAFETY: a null event-context GUID is allowed by the API.
        with_endpoint(id, |e| unsafe { e.SetMasterVolumeLevelScalar(scalar, std::ptr::null()) })
    }

    pub fn set_muted(id: &str, muted: bool) -> bool {
        // SAFETY: as above.
        with_endpoint(id, |e| unsafe { e.SetMute(muted, std::ptr::null()) })
    }
}

#[cfg(windows)]
pub(crate) use imp::enumerator;

#[cfg(windows)]
pub async fn list() -> Vec<Sink> {
    tokio::task::spawn_blocking(imp::list).await.unwrap_or_default()
}

#[cfg(windows)]
pub async fn set_volume(id: String, percent: u32) -> bool {
    tokio::task::spawn_blocking(move || imp::set_volume(&id, percent)).await.unwrap_or(false)
}

#[cfg(windows)]
pub async fn set_muted(id: String, muted: bool) -> bool {
    tokio::task::spawn_blocking(move || imp::set_muted(&id, muted)).await.unwrap_or(false)
}

#[cfg(not(windows))]
pub async fn list() -> Vec<Sink> {
    Vec::new()
}

#[cfg(not(windows))]
pub async fn set_volume(_id: String, _percent: u32) -> bool {
    false
}

#[cfg(not(windows))]
pub async fn set_muted(_id: String, _muted: bool) -> bool {
    false
}
