// What is playing on this PC and how to control it, through the Windows system media transport
// controls (the same sessions the volume flyout shows).
//
// One session manager is kept for the life of the process. `watch` subscribes to it (players coming
// and going, the current one changing) and to each player's track, playback and timeline events, and
// hands over the rebuilt state once a burst of events settles.

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
    use windows::core::Result;
    use windows::Foundation::TypedEventHandler;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as WinSession, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Win32::System::Com::{CoIncrementMTAUsage, CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    /// The process-wide session manager, requested once.
    fn manager() -> Result<Manager> {
        static MANAGER: std::sync::Mutex<Option<Manager>> = std::sync::Mutex::new(None);
        let mut slot = MANAGER.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(manager) = slot.as_ref() {
            return Ok(manager.clone());
        }
        // The manager lives in the multithreaded apartment for the rest of the process: keep that
        // apartment alive (no thread leaving it can tear it down), which also lets any thread use it.
        // SAFETY: plain COM call; the usage is held for the life of the process on purpose.
        unsafe { CoIncrementMTAUsage()? };
        let manager = Manager::RequestAsync()?.get()?;
        *slot = Some(manager.clone());
        Ok(manager)
    }

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

    fn read_all(manager: &Manager) -> Result<Vec<Session>> {
        Ok(manager.GetSessions()?.into_iter().filter_map(|s| read(&s).ok()).collect())
    }

    pub fn sessions() -> Vec<Session> {
        manager().and_then(|m| read_all(&m)).unwrap_or_default()
    }

    /// Applies `action` ("Play", "Pause", "PlayPause", "Next", "Previous", "Stop", "Seek:<ms>") to
    /// the named player, falling back to the system's current session.
    pub fn control(player: &str, action: &str) -> bool {
        (|| -> Result<bool> {
            let manager = manager()?;
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

    // ---- change events ----

    pub enum Msg {
        // Players came or went: subscribe to the new list.
        Sessions,
        // Something about a player (or which one is current) changed.
        Changed,
        Stop,
    }

    type Tx = std::sync::mpsc::Sender<Msg>;

    /// One player's event subscriptions, removed again by `unsubscribe`.
    struct Subscription {
        session: WinSession,
        tokens: [i64; 3],
    }

    fn subscribe(session: WinSession, tx: &Tx) -> Result<Subscription> {
        // The timeline carries the track length, which is part of the state peers get (the position
        // is not compared, so a position-only event costs a read and nothing more).
        let (a, b, c) = (tx.clone(), tx.clone(), tx.clone());
        let media = session.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
            let _ = a.send(Msg::Changed);
            Ok(())
        }))?;
        let playback = session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
            let _ = b.send(Msg::Changed);
            Ok(())
        }))?;
        let timeline = session.TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
            let _ = c.send(Msg::Changed);
            Ok(())
        }))?;
        Ok(Subscription { session, tokens: [media, playback, timeline] })
    }

    fn unsubscribe(sub: Subscription) {
        let [media, playback, timeline] = sub.tokens;
        let _ = sub.session.RemoveMediaPropertiesChanged(media);
        let _ = sub.session.RemovePlaybackInfoChanged(playback);
        let _ = sub.session.RemoveTimelinePropertiesChanged(timeline);
    }

    fn subscribe_all(manager: &Manager, tx: &Tx) -> Vec<Subscription> {
        manager
            .GetSessions()
            .map(|list| list.into_iter().filter_map(|s| subscribe(s, tx).ok()).collect())
            .unwrap_or_default()
    }

    /// The watcher thread: waits for events, lets a burst settle, rebuilds the state and hands it to
    /// `on_state`. Ends on Msg::Stop or when every sender is gone.
    pub fn run(tx: Tx, rx: std::sync::mpsc::Receiver<Msg>, on_state: Box<dyn Fn(Vec<Session>) + Send>) {
        use std::time::{Duration, Instant};
        const QUIET: Duration = Duration::from_millis(100);
        const MAX_WAIT: Duration = Duration::from_millis(400);

        // SAFETY: this thread joins the multithreaded apartment and leaves it at the end.
        let joined = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        (|| -> Result<()> {
            let manager = manager()?;
            let (a, b) = (tx.clone(), tx.clone());
            let sessions_token = manager.SessionsChanged(&TypedEventHandler::new(move |_, _| {
                let _ = a.send(Msg::Sessions);
                Ok(())
            }))?;
            let current_token = manager.CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
                let _ = b.send(Msg::Changed);
                Ok(())
            }))?;
            let mut subs = subscribe_all(&manager, &tx);

            'outer: while let Ok(first) = rx.recv() {
                let mut resubscribe = false;
                let started = Instant::now();
                let mut next = Some(first);
                while let Some(msg) = next {
                    match msg {
                        Msg::Stop => break 'outer,
                        Msg::Sessions => resubscribe = true,
                        Msg::Changed => {}
                    }
                    // Whatever arrives after MAX_WAIT starts the next round.
                    let left = MAX_WAIT.saturating_sub(started.elapsed());
                    if left.is_zero() {
                        break;
                    }
                    next = match rx.recv_timeout(QUIET.min(left)) {
                        Ok(msg) => Some(msg),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break 'outer,
                    };
                }
                if resubscribe {
                    subs.drain(..).for_each(unsubscribe);
                    subs = subscribe_all(&manager, &tx);
                }
                match read_all(&manager) {
                    Ok(state) => on_state(state),
                    Err(e) => log::warn!("[Media] could not read the sessions: {e}"),
                }
            }

            subs.drain(..).for_each(unsubscribe);
            let _ = manager.RemoveSessionsChanged(sessions_token);
            let _ = manager.RemoveCurrentSessionChanged(current_token);
            Ok(())
        })()
        .unwrap_or_else(|e| log::warn!("[Media] change events unavailable: {e}"));
        if joined {
            // SAFETY: balances the successful CoInitializeEx above. The shared manager outlives this
            // thread; it is agile, and manager() holds the apartment alive.
            unsafe { CoUninitialize() };
        }
    }
}

/// Watches the media sessions while it is alive; dropping it removes every subscription.
pub struct Watcher {
    #[cfg(windows)]
    stop: std::sync::mpsc::Sender<imp::Msg>,
}

#[cfg(windows)]
impl Drop for Watcher {
    fn drop(&mut self) {
        let _ = self.stop.send(imp::Msg::Stop);
    }
}

/// Calls `on_state` with every session (on the watcher's own thread, ~100 ms after a burst of events
/// settles) whenever a player comes or goes or its track, playback state, controls or timeline changes.
/// Every event is passed on, position-only ones included; deduplicating is up to the caller.
#[cfg(windows)]
pub fn watch(on_state: impl Fn(Vec<Session>) + Send + 'static) -> Watcher {
    let (tx, rx) = std::sync::mpsc::channel();
    let thread_tx = tx.clone();
    let spawned =
        std::thread::Builder::new().name("media-watch".into()).spawn(move || imp::run(thread_tx, rx, Box::new(on_state)));
    if let Err(e) = spawned {
        log::warn!("[Media] could not start the change watcher: {e}");
    }
    Watcher { stop: tx }
}

#[cfg(not(windows))]
pub fn watch(_on_state: impl Fn(Vec<Session>) + Send + 'static) -> Watcher {
    Watcher {}
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

#[cfg(all(test, windows))]
mod tests {
    // Runs against this machine's players: `cargo test --lib -- --ignored media_watcher --nocapture`.
    // A paused, seekable player is moved back a second (no audible change) to raise an event;
    // otherwise play, pause or skip something within 15 s to see an event-driven update.
    #[test]
    #[ignore]
    fn media_watcher_reports_changes() {
        let now = super::imp::sessions();
        println!("sessions now: {now:#?}");
        let (tx, rx) = std::sync::mpsc::channel();
        let watcher = super::watch(move |state| {
            let _ = tx.send(state);
        });
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Some(s) = now.iter().find(|s| s.can_seek && !s.is_playing) {
            let to = (s.pos_ms - 1000).max(0);
            println!("seeking {} to {to} ms: {}", s.player, super::imp::control(&s.player_id, &format!("Seek:{to}")));
        }
        match rx.recv_timeout(std::time::Duration::from_secs(15)) {
            Ok(state) => println!("event-driven update: {state:#?}"),
            Err(_) => println!("no media event within 15 s (nothing changed?)"),
        }
        drop(watcher);
    }
}
