// What is playing on this PC and how to control it, through the Windows system media transport
// controls (the same sessions the volume flyout shows). Mirrors electron/scripts/mpris-control.ps1.

#[derive(Clone, PartialEq, Debug, Default)]
pub struct Session {
    pub player: String,
    pub player_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub is_playing: bool,
    pub can_play: bool,
    pub can_pause: bool,
    pub can_go_next: bool,
    pub can_go_previous: bool,
    pub can_seek: bool,
    pub length_ms: i64,
    pub pos_ms: i64,
}

#[cfg(windows)]
mod imp {
    use super::Session;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as WinSession, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::core::Result;

    // "spotify.exe" -> "Spotify": the name the phone shows and sends back to pick a player.
    fn display_name(app_id: &str) -> String {
        let trimmed = app_id.strip_suffix(".exe").or_else(|| app_id.strip_suffix(".EXE")).unwrap_or(app_id);
        let mut chars = trimmed.chars();
        chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
    }

    fn read(session: &WinSession) -> Result<Session> {
        let app_id = session.SourceAppUserModelId()?.to_string();
        let props = session.TryGetMediaPropertiesAsync()?.get()?;
        let playback = session.GetPlaybackInfo()?;
        let timeline = session.GetTimelineProperties()?;
        let controls = playback.Controls()?;
        let ms = |ticks: i64| ticks / 10_000; // TimeSpan ticks are 100ns
        let title = props.Title()?.to_string();
        Ok(Session {
            player: display_name(&app_id),
            player_id: app_id,
            title: if title.is_empty() { "Unknown".into() } else { title },
            artist: props.Artist()?.to_string(),
            album: props.AlbumTitle()?.to_string(),
            is_playing: playback.PlaybackStatus()? == Status::Playing,
            can_play: controls.IsPlayEnabled().unwrap_or(false),
            can_pause: controls.IsPauseEnabled().unwrap_or(false),
            can_go_next: controls.IsNextEnabled().unwrap_or(false),
            can_go_previous: controls.IsPreviousEnabled().unwrap_or(false),
            can_seek: controls.IsPlaybackPositionEnabled().unwrap_or(false),
            length_ms: ms(timeline.EndTime()?.Duration),
            pos_ms: ms(timeline.Position()?.Duration),
        })
    }

    pub fn sessions() -> Vec<Session> {
        (|| -> Result<Vec<Session>> {
            let manager = Manager::RequestAsync()?.get()?;
            Ok(manager.GetSessions()?.into_iter().filter_map(|s| read(&s).ok()).collect())
        })()
        .unwrap_or_default()
    }

    /// Applies `action` ("Play", "Pause", "PlayPause", "Next", "Previous", "Stop", "Seek:<ms>") to
    /// the named player, falling back to the system's current session.
    pub fn control(player: &str, action: &str) -> bool {
        (|| -> Result<bool> {
            let manager = Manager::RequestAsync()?.get()?;
            let target = manager
                .GetSessions()?
                .into_iter()
                .find(|s| {
                    s.SourceAppUserModelId().map(|id| id.to_string()).is_ok_and(|id| id == player || display_name(&id) == player)
                })
                .or_else(|| manager.GetCurrentSession().ok());
            let Some(session) = target else { return Ok(false) };
            let done = match action {
                "PlayPause" => session.TryTogglePlayPauseAsync()?.get()?,
                "Play" => session.TryPlayAsync()?.get()?,
                "Pause" => session.TryPauseAsync()?.get()?,
                "Next" => session.TrySkipNextAsync()?.get()?,
                "Previous" => session.TrySkipPreviousAsync()?.get()?,
                "Stop" => session.TryStopAsync()?.get()?,
                seek if seek.starts_with("Seek:") => {
                    let ms: f64 = seek[5..].parse().unwrap_or(0.0);
                    session.TryChangePlaybackPositionAsync((ms * 10_000.0) as i64)?.get()?
                }
                _ => false,
            };
            Ok(done)
        })()
        .unwrap_or(false)
    }
}

#[cfg(windows)]
pub async fn sessions() -> Vec<Session> {
    tokio::task::spawn_blocking(imp::sessions).await.unwrap_or_default()
}

#[cfg(windows)]
pub async fn control(player: String, action: String) -> bool {
    tokio::task::spawn_blocking(move || imp::control(&player, &action)).await.unwrap_or(false)
}

#[cfg(not(windows))]
pub async fn sessions() -> Vec<Session> {
    Vec::new()
}

#[cfg(not(windows))]
pub async fn control(_player: String, _action: String) -> bool {
    false
}
