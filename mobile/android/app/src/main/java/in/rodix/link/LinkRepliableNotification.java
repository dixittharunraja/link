package in.rodix.link;

import android.app.PendingIntent;
import android.app.RemoteInput;
import java.util.UUID;

public class LinkRepliableNotification {
    public final String id;
    public final PendingIntent pendingIntent;
    public final RemoteInput[] remoteInputs;

    public LinkRepliableNotification(PendingIntent pendingIntent, RemoteInput[] remoteInputs) {
        this.id = UUID.randomUUID().toString();
        this.pendingIntent = pendingIntent;
        this.remoteInputs = remoteInputs;
    }
}
