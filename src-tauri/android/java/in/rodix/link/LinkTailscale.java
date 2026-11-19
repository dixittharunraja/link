package in.rodix.link;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.util.Collections;

// Tailscale awareness without any Tailscale API: its app gives this device an address in
// 100.64.0.0/10 while it is connected. Mirrors is_tailscale_ip / tailscale_ip in core/identity.rs.

public final class LinkTailscale {
    private LinkTailscale() {}

    /** Whether an address is in Tailscale's range, so a connection to it is a remote one. */
    public static boolean isTailscaleAddr(String ip) {
        if (ip == null) return false;
        String clean = ip.replace("::ffff:", "");
        String[] parts = clean.split("\\.");
        if (parts.length != 4) return false;
        try {
            int first = Integer.parseInt(parts[0]);
            int second = Integer.parseInt(parts[1]);
            return first == 100 && second >= 64 && second <= 127;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    /** This device's Tailscale address, or null when Tailscale is not connected. */
    public static String localAddress() {
        try {
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp()) continue;
                for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
                    if (addr instanceof Inet4Address && isTailscaleAddr(addr.getHostAddress())) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /** Whether an address lies on a network this device is attached to now (Tailscale's excluded). */
    public static boolean onLocalSubnet(String ip) {
        if (ip == null) return false;
        try {
            byte[] target = InetAddress.getByName(ip).getAddress();
            if (target.length != 4) return false;
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InterfaceAddress ia : nif.getInterfaceAddresses()) {
                    InetAddress addr = ia.getAddress();
                    if (!(addr instanceof Inet4Address) || isTailscaleAddr(addr.getHostAddress())) continue;
                    byte[] mine = addr.getAddress();
                    int prefix = ia.getNetworkPrefixLength();
                    boolean same = true;
                    for (int bit = 0; bit < prefix && same; bit++) {
                        int mask = 0x80 >> (bit % 8);
                        same = (mine[bit / 8] & mask) == (target[bit / 8] & mask);
                    }
                    if (same) return true;
                }
            }
        } catch (Exception ignored) {
        }
        return false;
    }
}
