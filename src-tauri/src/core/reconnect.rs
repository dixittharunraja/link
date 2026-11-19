use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::core::identity::{is_tailscale_addr, is_tailscale_ip};
use crate::core::packet::{LinkPacket, PACKET_TYPE_HEARTBEAT};
use crate::core::transport::{DeviceManager, LINK_PORT};

// Keeps paired devices connected: a device that is paired but not connected is dialled, at the
// address it is currently broadcasting from (else the last one it connected from). The phone does
// the same from its side; the duplicate-connection rule in transport.rs reconciles the two.

// Between passes the loop sleeps this long while a paired device is missing, IDLE_TICK once all are
// connected (then it is only watching for a network change or sleep). A connection ending, or a
// device being heard anew, wakes it at once (DiscoveryManager::redial_signal).
const TICK: Duration = Duration::from_secs(3);
const IDLE_TICK: Duration = Duration::from_secs(6);
const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(15);
// The longest wait between dials of a paired device that has stayed silent through several attempts.
const SILENT_BACKOFF: Duration = Duration::from_secs(30);
// The longest wait while the device is announcing itself on the LAN (it is there; a failure is passing).
const HEARD_BACKOFF: Duration = Duration::from_secs(3);
// A live connection must answer a probe within this long after the network changed.
const PROBE_GRACE: Duration = Duration::from_secs(3);
// After waking or a network change, Wi-Fi often takes several seconds to come back while the adapter keeps its
// address (so no second change is seen). Failed dials in this window retry after MIN_BACKOFF instead of building
// a backoff that would still be holding off once the network is up.
const SETTLE: Duration = Duration::from_secs(30);
// Searching every address of the subnet is a lot of packets. The first search comes at once, the next
// ones further and further apart while the device stays missing; a network change starts over.
const SWEEP_FIRST_GAP: Duration = Duration::from_secs(10);
const SWEEP_MAX_GAP: Duration = Duration::from_secs(1800);
// With nothing paired, or everything connected, the loop only waits for a wake (a connection ending, a device heard,
// Add Device opening) and checks for a network change this often.
const PARK: Duration = Duration::from_secs(3);
// How often Link devices on the tailnet are announced to (see tailnet_announce_targets).
const TAILNET_REFRESH: Duration = crate::core::discovery::TAILNET_ANNOUNCE;

/// Tailscale (and other CGNAT overlay) addresses: a device there is not on the local subnet, so searching
/// the subnet for it is pointless.
fn is_overlay(ip: &str) -> bool {
    is_tailscale_addr(ip)
}

/// The setting behind the "Use Tailscale when away" switch.
pub const REMOTE_SETTING: &str = "remote_tailscale";

/// Whether an address lies on a network this device is currently attached to (not counting Tailscale's).
fn on_local_subnet(ip: &str, subnets: &[(u32, u32)]) -> bool {
    let Ok(IpAddr::V4(ip)) = ip.parse::<IpAddr>() else { return false };
    subnets.iter().any(|(network, mask)| ip.to_bits() & mask == *network)
}

/// Each attached non-Tailscale IPv4 network as (network, mask); listed once per pass, not per device.
fn local_subnets() -> Vec<(u32, u32)> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .iter()
        .filter_map(|interface| match &interface.addr {
            if_addrs::IfAddr::V4(v4) if !is_tailscale_ip(IpAddr::V4(v4.ip)) => {
                let mask = v4.netmask.to_bits();
                Some((v4.ip.to_bits() & mask, mask))
            }
            _ => None,
        })
        .collect()
}

fn local_addresses() -> HashSet<IpAddr> {
    local_ip_address::list_afinet_netifas().unwrap_or_default().into_iter().map(|(_, ip)| ip).filter(|ip| !ip.is_loopback()).collect()
}

struct Backoff {
    next_attempt: Instant,
    failures: u32,
}

#[derive(Default)]
struct Dialing {
    in_flight: HashSet<String>,
    backoff: HashMap<String, Backoff>,
    // Until when failures retry quickly (SETTLE).
    settle_until: Option<Instant>,
}

impl DeviceManager {
    pub fn start_reconnect_loop(self: &Arc<Self>) {
        let manager = self.clone();
        let state = Arc::new(Mutex::new(Dialing::default()));
        let redial = manager.discovery.redial_signal();
        tokio::spawn(async move {
            let mut wait = Duration::ZERO;
            let mut addresses = local_addresses();
            let mut last_tick = Instant::now();
            let mut sweep_gap = SWEEP_FIRST_GAP;
            let sweeping = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let mut last_sweep = Instant::now() - sweep_gap;
            crate::core::identity::note_local_addresses(&addresses);
            let mut tailnet_announced = Instant::now() - TAILNET_REFRESH;
            // Whether the Add Device screen was open at the last tailnet announcement.
            let mut tailnet_pairing = false;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = redial.notified() => {
                        // Several wakes in a burst (a few announcements, a dropped connection) make one pass.
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                }
                // The adapters are listed once per pass; the Tailscale check below reads the same list.
                let current = local_addresses();
                // A gap well past the planned wait means the machine slept; its connections died with it.
                let slept = last_tick.elapsed() > wait + TICK * 3;
                last_tick = Instant::now();
                if current != addresses || slept {
                    log::info!("Network changed (woke from sleep: {}); redialling paired devices", slept);
                    addresses = current;
                    crate::core::identity::note_local_addresses(&addresses);
                    sweep_gap = SWEEP_FIRST_GAP;
                    last_sweep = Instant::now() - sweep_gap;
                    state
                        .lock()
                        .map(|mut s| {
                            s.backoff.clear();
                            s.settle_until = Some(Instant::now() + SETTLE);
                        })
                        .ok();
                    manager.discovery.network_changed();
                    manager.probe_connections().await;
                }
                // Announcements go over Tailscale only while this device is visible and the user allowed
                // Tailscale: a broadcast does not cross it, so each goes straight to a device's address.
                let on_tailnet = addresses.iter().any(|ip| is_tailscale_ip(*ip));
                let remote = manager.settings.lock().is_ok_and(|s| s.get_bool(REMOTE_SETTING, false)) && on_tailnet;
                manager.discovery.set_remote_discovery(remote);
                let pairing = manager.pairing_window.lock().is_ok_and(|w| w.is_open(Instant::now()));
                // Opening Add Device announces at once rather than at the next refresh.
                let due = tailnet_announced.elapsed() >= TAILNET_REFRESH || (pairing && !tailnet_pairing);
                tailnet_pairing &= pairing;
                if remote && due && manager.discovery.is_visible().await {
                    tailnet_announced = Instant::now();
                    tailnet_pairing = pairing;
                    let targets = manager.tailnet_announce_targets(pairing).await;
                    manager.discovery.announce_to(&targets).await;
                }
                let (unreachable, all_connected) = manager.dial_missing_peers(&state, remote).await;
                // Fast announcements only while a paired device is missing or Add Device is open.
                manager.discovery.set_fast_mode(!all_connected || pairing);
                wait = if pairing {
                    IDLE_TICK
                } else if all_connected {
                    // Nothing paired, or everything connected: wait for a wake instead of ticking.
                    PARK
                } else {
                    TICK
                };
                if !unreachable {
                    sweep_gap = SWEEP_FIRST_GAP;
                } else if last_sweep.elapsed() >= sweep_gap && !sweeping.swap(true, Ordering::AcqRel) {
                    last_sweep = Instant::now();
                    sweep_gap = (sweep_gap * 3).min(SWEEP_MAX_GAP);
                    // About a thousand sends per adapter: off the reconnect loop, and never two at once.
                    let (manager, sweeping) = (manager.clone(), sweeping.clone());
                    tokio::spawn(async move {
                        manager.discovery.sweep_local_subnets().await;
                        sweeping.store(false, Ordering::Release);
                    });
                }
            }
        });
    }

    /// Where a tailnet announcement goes: Link devices only, not every node on the tailnet. That is
    /// paired devices not connected now, at their recorded Tailscale address, and devices heard
    /// announcing over Tailscale (kept listed while the user decides whether to pair them). Only
    /// while the Add Device screen is open does it go to every online tailnet node, which is how a
    /// phone there that has never met this PC finds it (the phone only answers announcements).
    async fn tailnet_announce_targets(&self, pairing: bool) -> Vec<std::net::Ipv4Addr> {
        let connected: HashSet<String> = self.active_peers.read().await.iter().filter(|(_, p)| p.trusted).map(|(id, _)| id.clone()).collect();
        let mut targets: HashSet<std::net::Ipv4Addr> = self
            .trust_store
            .read()
            .await
            .list()
            .into_iter()
            .filter(|d| !connected.contains(&d.device_id))
            .filter_map(|d| d.tailscale_ip?.parse().ok())
            .collect();
        targets.extend(
            self.discovery
                .get_discovered_peers()
                .read()
                .await
                .values()
                .filter(|p| !connected.contains(&p.device_id))
                .filter_map(|p| p.ip.parse::<std::net::Ipv4Addr>().ok())
                .filter(|ip| is_tailscale_ip(IpAddr::V4(*ip))),
        );
        if pairing {
            let peers = tokio::task::spawn_blocking(crate::core::tailnet::peers).await.unwrap_or_default();
            targets.extend(peers.into_iter().map(|p| p.address));
        }
        targets.into_iter().collect()
    }

    /// Asks every connection to prove it is alive; one that stays silent is ended, so the redial
    /// does not wait for the heartbeat timeout.
    async fn probe_connections(&self) {
        let peers: Vec<_> = self
            .active_peers
            .read()
            .await
            .iter()
            .map(|(id, p)| (id.clone(), p.tx.clone(), p.last_rx.clone(), p.last_rx.load(Ordering::Relaxed), p.shutdown.clone()))
            .collect();
        for (id, tx, last_rx, before, shutdown) in peers {
            let _ = tx.send(LinkPacket::new(PACKET_TYPE_HEARTBEAT, serde_json::json!({ "reply": false }))).await;
            tokio::spawn(async move {
                tokio::time::sleep(PROBE_GRACE).await;
                if last_rx.load(Ordering::Relaxed) == before {
                    log::info!("Connection to {} did not answer after the network changed; ending it", id);
                    shutdown.notify_one();
                }
            });
        }
    }

    /// Dials paired devices that are not connected. Returns whether any of them has no address
    /// to try (not heard from, never connected), which is when searching the subnet helps, and
    /// whether every paired device is connected over the LAN.
    /// `remote_allowed` is "Use Tailscale when away": reach a peer through the tailnet only when it is
    /// not on the LAN, this device has Tailscale running, and the peer's tailnet address is known.
    async fn dial_missing_peers(self: &Arc<Self>, state: &Arc<Mutex<Dialing>>, remote_allowed: bool) -> (bool, bool) {
        let mut unreachable = false;
        // A device heard again after going quiet, or at a new address, has just woken or moved: dial it now
        // rather than after the backoff its silence built up.
        let anew = self.discovery.take_heard_anew();
        if !anew.is_empty() {
            if let Ok(mut s) = state.lock() {
                for id in &anew {
                    s.backoff.remove(id);
                }
            }
        }
        let trusted = self.trust_store.read().await.list();
        // So a paired device with Device Visibility off is still recognised by its anonymous announcement.
        self.discovery.set_paired(&trusted);
        // Nothing paired: nothing to dial, and nothing to announce quickly for (Add Device speeds it up).
        if trusted.is_empty() {
            return (false, true);
        }
        // Announce quickly only while someone paired is missing.
        let mut all_connected = true;
        // Only the paired devices' entries, not a copy of the whole discovered table.
        let discovered: HashMap<String, String> = {
            let map = self.discovery.get_discovered_peers();
            let map = map.read().await;
            trusted.iter().filter_map(|d| map.get(&d.device_id).map(|p| (d.device_id.clone(), p.ip.clone()))).collect()
        };
        // Who is connected, read once rather than locking the peer table per device.
        let active: HashMap<String, String> = self.active_peers.read().await.iter().filter(|(_, p)| p.trusted).map(|(id, p)| (id.clone(), p.ip.clone())).collect();
        // The adapters' networks, listed once and only if a device needs the check.
        let mut subnets: Option<Vec<(u32, u32)>> = None;
        for device in trusted {
            let id = device.device_id;
            // Where the peer is heard on the LAN now (broadcasts never arrive over Tailscale).
            let lan_ip = discovered.get(&id).cloned().filter(|ip| !is_tailscale_addr(ip));
            let active_ip = active.get(&id).cloned();
            if let Some(active) = &active_ip {
                if is_tailscale_addr(active) {
                    // Keep listening for the LAN while remote, so coming home is noticed quickly.
                    all_connected = false;
                }
                // Connected over Tailscale while the peer is heard on the LAN: we are home, so dial
                // the LAN address; the duplicate rule in transport.rs drops the remote link.
                if !(is_tailscale_addr(active) && lan_ip.is_some()) {
                    state.lock().map(|mut s| s.backoff.remove(&id)).ok();
                    continue;
                }
            } else {
                all_connected = false;
            }
            let failures = state.lock().ok().and_then(|s| s.backoff.get(&id).map(|b| b.failures)).unwrap_or(0);
            let remote_ip = device.tailscale_ip.clone().filter(|_| remote_allowed);
            let ip = match (lan_ip, remote_ip, device.ip_address) {
                (Some(lan), _, _) => lan,
                // The last LAN address is on a network this device is no longer on, or it did not answer.
                (None, Some(remote), last) if last.as_deref().is_none_or(|ip| !on_local_subnet(ip, subnets.get_or_insert_with(local_subnets))) || failures >= 1 => remote,
                (None, _, Some(last)) => last,
                (None, Some(remote), None) => remote,
                (None, None, None) => {
                    unreachable = true;
                    continue;
                }
            };
            unreachable |= !is_overlay(&ip) && !discovered.contains_key(&id) && state.lock().is_ok_and(|s| s.backoff.get(&id).is_some_and(|b| b.failures >= 2));
            if self.is_blocked(&id) || self.is_blocked(&ip) {
                continue;
            }
            let due = state
                .lock()
                .map(|mut s| s.backoff.get(&id).is_none_or(|b| Instant::now() >= b.next_attempt) && s.in_flight.insert(id.clone()))
                .unwrap_or(false);
            if !due {
                continue;
            }
            let (manager, state) = (self.clone(), state.clone());
            tokio::spawn(async move {
                let result = manager.connect_to(&ip, LINK_PORT).await;
                let heard = manager.discovery.get_discovered_peers().read().await.contains_key(&id);
                if let Ok(mut s) = state.lock() {
                    s.in_flight.remove(&id);
                    match result {
                        Ok(_) => {
                            s.backoff.remove(&id);
                        }
                        Err(e) => {
                            log::info!("Reconnect to {} at {} failed: {}", id, ip, e);
                            let failures = s.backoff.get(&id).map_or(1, |b| b.failures + 1);
                            // A device that is announcing itself is here, so keep trying every few seconds. One
                            // that is silent (switched off, away, or a phone asleep whose announcements have
                            // stopped) is still tried every SILENT_BACKOFF: a phone coming home with its screen
                            // off is often only found by being dialled, and a longer wait is what made
                            // reconnecting take minutes.
                            let cap = match failures {
                                _ if heard => HEARD_BACKOFF,
                                0..=5 => MAX_BACKOFF,
                                _ => SILENT_BACKOFF,
                            };
                            // Doubling up to the cap: 1, 2, 4 ... s.
                            let settling = s.settle_until.is_some_and(|until| Instant::now() < until);
                            let delay = if settling { MIN_BACKOFF } else { MIN_BACKOFF.saturating_mul(1 << failures.min(9)).min(cap) };
                            s.backoff.insert(id, Backoff { next_attempt: Instant::now() + delay, failures });
                        }
                    }
                }
            });
        }
        (unreachable, all_connected)
    }
}
