use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::core::packet::{LinkPacket, PACKET_TYPE_HEARTBEAT};
use crate::core::transport::{DeviceManager, LINK_PORT};

// Keeps paired devices connected: a device that is paired but not connected is dialled, at the
// address it is currently broadcasting from (else the last one it connected from). The phone does
// the same from its side; the duplicate-connection rule in transport.rs reconciles the two.

const TICK: Duration = Duration::from_secs(3);
const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(15);
// A live connection must answer a probe within this long after the network changed.
const PROBE_GRACE: Duration = Duration::from_secs(3);
const SWEEP_EVERY: Duration = Duration::from_secs(10);

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
}

impl DeviceManager {
    pub fn start_reconnect_loop(self: &Arc<Self>) {
        let manager = self.clone();
        let state = Arc::new(Mutex::new(Dialing::default()));
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(TICK);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut addresses = local_addresses();
            let mut last_tick = Instant::now();
            let mut last_sweep = Instant::now() - SWEEP_EVERY;
            loop {
                tick.tick().await;
                let current = local_addresses();
                // A long gap between ticks means the machine slept; its connections died with it.
                let slept = last_tick.elapsed() > TICK * 4;
                last_tick = Instant::now();
                if current != addresses || slept {
                    log::info!("Network changed (woke from sleep: {}); redialling paired devices", slept);
                    addresses = current;
                    state.lock().map(|mut s| s.backoff.clear()).ok();
                    manager.probe_connections().await;
                }
                let unreachable = manager.dial_missing_peers(&state).await;
                if unreachable && last_sweep.elapsed() >= SWEEP_EVERY {
                    last_sweep = Instant::now();
                    manager.discovery.sweep_local_subnets().await;
                }
            }
        });
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
    /// to try (not heard from, never connected), which is when searching the subnet helps.
    async fn dial_missing_peers(self: &Arc<Self>, state: &Arc<Mutex<Dialing>>) -> bool {
        let mut unreachable = false;
        let trusted = self.trust_store.read().await.list();
        let discovered = self.discovery.get_discovered_peers().read().await.clone();
        for device in trusted {
            let id = device.device_id;
            if self.active_peers.read().await.get(&id).is_some_and(|p| p.trusted) {
                state.lock().map(|mut s| s.backoff.remove(&id)).ok();
                continue;
            }
            let Some(ip) = discovered.get(&id).map(|p| p.ip.clone()).or(device.ip_address) else {
                unreachable = true;
                continue;
            };
            unreachable |= !discovered.contains_key(&id) && state.lock().is_ok_and(|s| s.backoff.get(&id).is_some_and(|b| b.failures >= 2));
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
                if let Ok(mut s) = state.lock() {
                    s.in_flight.remove(&id);
                    match result {
                        Ok(_) => {
                            s.backoff.remove(&id);
                        }
                        Err(e) => {
                            log::info!("Reconnect to {} at {} failed: {}", id, ip, e);
                            let failures = s.backoff.get(&id).map_or(1, |b| b.failures + 1);
                            let delay = MIN_BACKOFF.saturating_mul(1 << failures.min(4)).min(MAX_BACKOFF);
                            s.backoff.insert(id, Backoff { next_attempt: Instant::now() + delay, failures });
                        }
                    }
                }
            });
        }
        unreachable
    }
}
