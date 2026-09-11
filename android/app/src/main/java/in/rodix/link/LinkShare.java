package in.rodix.link;

// Share plugin — SCOPED-DOWN port of kdeconnect-android's share plugin. Single-file transfer
// only, to prove the payload-transfer mechanism end-to-end. See
// desktop/src/core/plugins/share.ts's header comment and docs/features.txt for the full
// disclosed scope gap versus real upstream (multi-file, download-folder config, open-on-receipt).

import org.json.JSONObject;

import java.security.PrivateKey;
import java.security.cert.X509Certificate;

public class LinkShare {
    public static final String PACKET_TYPE_SHARE_REQUEST = "link.share.request";

    public static class PreparedShare {
        public final LinkPacket packet;
        public final LinkPayloadTransfer.UploadHandle upload;

        PreparedShare(LinkPacket packet, LinkPayloadTransfer.UploadHandle upload) {
            this.packet = packet;
            this.upload = upload;
        }
    }

    public static PreparedShare prepare(String filename, byte[] data, X509Certificate cert, PrivateKey key, LinkPayloadTransfer.UploadListener listener) throws Exception {
        LinkPayloadTransfer.UploadHandle upload = LinkPayloadTransfer.startUpload(cert, key, data, listener);

        JSONObject body = new JSONObject();
        body.put("filename", filename);
        LinkPacket packet = new LinkPacket(PACKET_TYPE_SHARE_REQUEST, body);
        packet.payloadSize = (long) data.length;
        JSONObject transferInfo = new JSONObject();
        transferInfo.put("port", upload.port);
        packet.payloadTransferInfo = transferInfo;

        return new PreparedShare(packet, upload);
    }

    public static boolean isShareRequestPacket(LinkPacket packet) {
        return PACKET_TYPE_SHARE_REQUEST.equals(packet.type);
    }

    public static byte[] receive(LinkPacket packet, String senderHost, X509Certificate cert, PrivateKey key, String expectedPeerFingerprint) throws Exception {
        int port = packet.payloadTransferInfo.getInt("port");
        return LinkPayloadTransfer.downloadPayload(senderHost, port, cert, key, expectedPeerFingerprint);
    }

    public static String filenameOf(LinkPacket packet) {
        return packet.body.optString("filename", "unknown");
    }
}
