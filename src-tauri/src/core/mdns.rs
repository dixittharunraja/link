// mDNS discovery for PAIRED devices only. It supplements the UDP broadcast and subnet sweep in
// discovery.rs (some managed networks drop broadcasts but pass mDNS) and is never used by the guest
// tools (Portal and the rest): a stranger is never found this way.
//
// Privacy: the service is `_link._tcp.local.` on LINK_PORT with no TXT data, no device name and no
// type. Its instance name is an opaque id that rotates every hour:
//
//     id = hex( SHA-256( "link-mdns-v1" || device_id || epoch )[0..8] )
//
// where `"link-mdns-v1"` is its 12 ASCII bytes, `device_id` its UTF-8 bytes and `epoch` an 8-byte
// big-endian u64, unix_seconds / 3600. The Android core (LinkMdns.java) computes the same bytes. A
// paired device derives the ids of every trusted device for the previous, current and next epoch and
// reacts only to a match, so a passive observer sees a random-looking 16 hex digit name that changes
// hourly and cannot be tied to a device name, type or to the same device an hour later.
//
// A match feeds DiscoveryManager::note_trusted_peer, the same table the UDP announcements fill, so
// reconnect.rs dials it exactly as it dials a device heard by broadcast.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use sha2::{Digest, Sha256};

use crate::core::transport::{DeviceManager, LINK_PORT};

pub const SERVICE_TYPE: &str = "_link._tcp.local.";
const LABEL: &[u8] = b"link-mdns-v1";
const EPOCH_SECS: u64 = 3600;
// How often the state is reconciled (trust, visibility, epoch) and heard devices are re-published.
const TICK: Duration = Duration::from_secs(5);
// How long a device found here stays listed without being heard again; re-published every TICK while
// its record lives, so it ends within this long of the device going away.
const PEER_INTERVAL_MS: i64 = 15_000;

/// The hour a rotating id belongs to.
pub fn epoch_at(unix_secs: u64) -> u64 {
    unix_secs / EPOCH_SECS
}

/// The opaque instance name a device advertises during `epoch`: 16 hex digits.
pub fn instance_id(device_id: &str, epoch: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(LABEL);
    hasher.update(device_id.as_bytes());
    hasher.update(epoch.to_be_bytes());
    hex::encode(&hasher.finalize()[..8])
}

/// Instance name → device id, for every given device in the epochs around `epoch` (clocks differ a little
/// and an id may be heard just after the hour turns).
pub fn trusted_instances(device_ids: &[String], epoch: u64) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for id in device_ids {
        for e in [epoch.saturating_sub(1), epoch, epoch + 1] {
            map.insert(instance_id(id, e), id.clone());
        }
    }
    map
}

/// The instance label of `<label>._link._tcp.local.`.
pub fn instance_of_fullname(fullname: &str) -> Option<&str> {
    fullname.strip_suffix(SERVICE_TYPE)?.strip_suffix('.')
}

/// The address to dial among those a record carries: not loopback, link-local, multicast or
/// unspecified, and on a local subnet when one of them is (`subnets` are this device's own address and
/// mask pairs). Deterministic when several qualify.
pub fn pick_ipv4(addresses: impl IntoIterator<Item = Ipv4Addr>, subnets: &[(Ipv4Addr, Ipv4Addr)]) -> Option<Ipv4Addr> {
    let mut usable: Vec<Ipv4Addr> = addresses
        .into_iter()
        .filter(|ip| !(ip.is_loopback() || ip.is_link_local() || ip.is_multicast() || ip.is_unspecified() || ip.is_broadcast()))
        .collect();
    usable.sort();
    let on_subnet = |ip: &Ipv4Addr| subnets.iter().any(|(own, mask)| ip.to_bits() & mask.to_bits() == own.to_bits() & mask.to_bits());
    usable.iter().copied().find(on_subnet).or_else(|| usable.first().copied())
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn local_subnets() -> Vec<(Ipv4Addr, Ipv4Addr)> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .iter()
        .filter_map(|interface| match &interface.addr {
            if_addrs::IfAddr::V4(v4) if !interface.is_loopback() => Some((v4.ip, v4.netmask)),
            _ => None,
        })
        .collect()
}

struct Advertised {
    epoch: u64,
    fullname: String,
}

struct State {
    daemon: Option<ServiceDaemon>,
    events: Option<mdns_sd::Receiver<ServiceEvent>>,
    advertised: Option<Advertised>,
    // Paired devices heard: device id → (record name, address).
    heard: HashMap<String, (String, Ipv4Addr)>,
}

impl State {
    fn stop_all(&mut self) {
        if let Some(daemon) = self.daemon.take() {
            let _ = daemon.shutdown();
        }
        self.events = None;
        self.advertised = None;
        self.heard.clear();
    }
}

/// Starts the mDNS task. It follows the trust store and the visibility setting: with nobody paired it
/// does nothing at all, and while this device is not visible it listens but advertises nothing.
pub fn start(manager: Arc<DeviceManager>) {
    tauri::async_runtime::spawn(async move {
        let mut state = State { daemon: None, events: None, advertised: None, heard: HashMap::new() };
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            // The next record event, or never while nothing is being browsed.
            let event = async {
                match &state.events {
                    Some(rx) => rx.recv_async().await.ok(),
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                _ = tick.tick() => reconcile(&manager, &mut state).await,
                event = event => match event {
                    Some(event) => handle_event(&manager, &mut state, event).await,
                    // The daemon ended; the next tick starts a new one.
                    None => state.stop_all(),
                },
            }
        }
    });
}

async fn trusted_ids(manager: &DeviceManager) -> Vec<String> {
    manager.trust_store.read().await.list().into_iter().map(|d| d.device_id).collect()
}

async fn reconcile(manager: &Arc<DeviceManager>, state: &mut State) {
    let trusted = trusted_ids(manager).await;
    if trusted.is_empty() {
        state.stop_all();
        return;
    }
    if state.daemon.is_none() {
        match ServiceDaemon::new() {
            Ok(daemon) => state.daemon = Some(daemon),
            Err(e) => {
                log::warn!("[Link mDNS]: could not start: {}", e);
                return;
            }
        }
    }
    let Some(daemon) = state.daemon.clone() else { return };
    if state.events.is_none() {
        match daemon.browse(SERVICE_TYPE) {
            Ok(rx) => state.events = Some(rx),
            Err(e) => log::warn!("[Link mDNS]: could not browse: {}", e),
        }
    }

    // Advertise only while visible, under this hour's id; a new hour means a new id.
    let epoch = epoch_at(unix_now());
    let visible = manager.discovery.is_visible().await;
    let stale = state.advertised.as_ref().is_some_and(|a| !visible || a.epoch != epoch);
    if stale {
        if let Some(old) = state.advertised.take() {
            let _ = daemon.unregister(&old.fullname);
        }
    }
    if visible && state.advertised.is_none() {
        let id = instance_id(&manager.identity.device_id, epoch);
        // Nothing here names the device: the host name is the opaque id too, and there is no TXT data.
        let info = ServiceInfo::new(SERVICE_TYPE, &id, &format!("{id}.local."), "", LINK_PORT, None::<HashMap<String, String>>);
        match info.map(|i| i.enable_addr_auto()) {
            Ok(info) => {
                let fullname = info.get_fullname().to_string();
                match daemon.register(info) {
                    Ok(()) => state.advertised = Some(Advertised { epoch, fullname }),
                    Err(e) => log::warn!("[Link mDNS]: could not advertise: {}", e),
                }
            }
            Err(e) => log::warn!("[Link mDNS]: bad service: {}", e),
        }
    }

    // Keep devices still alive in the record cache listed; forget ones no longer paired.
    state.heard.retain(|id, _| trusted.contains(id));
    let names: HashMap<String, String> = manager.trust_store.read().await.list().into_iter().map(|d| (d.device_id, d.device_name)).collect();
    for (id, (_, ip)) in &state.heard {
        let name = names.get(id).cloned().unwrap_or_default();
        manager.discovery.note_trusted_peer(id, &name, &ip.to_string(), PEER_INTERVAL_MS).await;
    }
}

async fn handle_event(manager: &Arc<DeviceManager>, state: &mut State, event: ServiceEvent) {
    match event {
        ServiceEvent::ServiceResolved(service) => {
            let Some(instance) = instance_of_fullname(service.get_fullname()) else { return };
            let trusted = trusted_ids(manager).await;
            let Some(device_id) = trusted_instances(&trusted, epoch_at(unix_now())).remove(instance) else { return };
            if device_id == manager.identity.device_id {
                return;
            }
            let addresses = service.get_addresses().iter().filter_map(|a| match a.to_ip_addr() {
                IpAddr::V4(v4) => Some(v4),
                IpAddr::V6(_) => None,
            });
            let Some(ip) = pick_ipv4(addresses, &local_subnets()) else { return };
            let name = manager.trust_store.read().await.get(&device_id).map(|d| d.device_name.clone()).unwrap_or_default();
            manager.discovery.note_trusted_peer(&device_id, &name, &ip.to_string(), PEER_INTERVAL_MS).await;
            state.heard.insert(device_id, (service.get_fullname().to_string(), ip));
        }
        ServiceEvent::ServiceRemoved(_, fullname) => {
            state.heard.retain(|_, (name, _)| *name != fullname);
        }
        _ => {}
    }
}
