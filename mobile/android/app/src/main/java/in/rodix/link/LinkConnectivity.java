package in.rodix.link;

import android.annotation.SuppressLint;
import android.content.Context;
import android.telephony.PhoneStateListener;
import android.telephony.SignalStrength;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;
import android.util.Log;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;

public class LinkConnectivity {
    public static final String PACKET_TYPE_CONNECTIVITY = "link.connectivity_report";
    private static final String TAG = "LinkConnectivity";

    public static class SubscriptionState {
        public int signalStrength = 0;
        public String networkType = "Unknown";
    }

    public interface Listener {
        void onChange(Map<String, SubscriptionState> states);
    }

    public static LinkPacket createPacket(Map<String, SubscriptionState> states) {
        try {
            JSONObject body = new JSONObject();
            JSONObject signalStrengths = new JSONObject();
            for (Map.Entry<String, SubscriptionState> entry : states.entrySet()) {
                JSONObject subInfo = new JSONObject();
                subInfo.put("networkType", entry.getValue().networkType);
                subInfo.put("signalStrength", entry.getValue().signalStrength);
                signalStrengths.put(entry.getKey(), subInfo);
            }
            body.put("signalStrengths", signalStrengths);
            return new LinkPacket(PACKET_TYPE_CONNECTIVITY, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static class Watcher {
        private final Context context;
        private final Listener listener;
        private final SubscriptionManager subscriptionManager;
        private final TelephonyManager telephonyManager;
        private final Map<Integer, PhoneStateListener> activeListeners = new HashMap<>();
        private final Map<String, SubscriptionState> states = new HashMap<>();
        private SubscriptionManager.OnSubscriptionsChangedListener subscriptionsChangedListener;

        @SuppressLint("MissingPermission")
        public Watcher(Context context, Listener listener) {
            this.context = context.getApplicationContext();
            this.listener = listener;
            this.subscriptionManager = (SubscriptionManager) context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
            this.telephonyManager = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N && subscriptionManager != null) {
                subscriptionsChangedListener = new SubscriptionManager.OnSubscriptionsChangedListener() {
                    @Override
                    public void onSubscriptionsChanged() {
                        updateSubscriptions();
                    }
                };
                subscriptionManager.addOnSubscriptionsChangedListener(subscriptionsChangedListener);
                updateSubscriptions();
            } else {
                setupSingleSimListener();
            }
        }

        @SuppressLint("MissingPermission")
        private void updateSubscriptions() {
            if (subscriptionManager == null) return;
            List<SubscriptionInfo> activeInfos = subscriptionManager.getActiveSubscriptionInfoList();
            if (activeInfos == null) {
                setupSingleSimListener();
                return;
            }

            Map<Integer, SubscriptionInfo> activeMap = new HashMap<>();
            for (SubscriptionInfo info : activeInfos) {
                activeMap.put(info.getSubscriptionId(), info);
            }

            for (Integer subId : new HashMap<>(activeListeners).keySet()) {
                if (!activeMap.containsKey(subId)) {
                    TelephonyManager subTm = telephonyManager.createForSubscriptionId(subId);
                    subTm.listen(activeListeners.get(subId), PhoneStateListener.LISTEN_NONE);
                    activeListeners.remove(subId);
                    states.remove(String.valueOf(subId));
                }
            }

            for (SubscriptionInfo info : activeInfos) {
                int subId = info.getSubscriptionId();
                if (!activeListeners.containsKey(subId)) {
                    TelephonyManager subTm = telephonyManager.createForSubscriptionId(subId);
                    SubscriptionState state = new SubscriptionState();
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                        state.signalStrength = getSignalStrengthLevel(subTm.getSignalStrength());
                        state.networkType = getNetworkTypeString(subTm.getDataNetworkType());
                    }
                    states.put(String.valueOf(subId), state);

                    PhoneStateListener phoneStateListener = createPhoneStateListener(subId);
                    activeListeners.put(subId, phoneStateListener);
                    subTm.listen(phoneStateListener, PhoneStateListener.LISTEN_SIGNAL_STRENGTHS | PhoneStateListener.LISTEN_DATA_CONNECTION_STATE);
                }
            }
            listener.onChange(states);
        }

        private void setupSingleSimListener() {
            int subId = 0;
            if (!activeListeners.containsKey(subId)) {
                SubscriptionState state = new SubscriptionState();
                states.put(String.valueOf(subId), state);
                PhoneStateListener phoneStateListener = createPhoneStateListener(subId);
                activeListeners.put(subId, phoneStateListener);
                telephonyManager.listen(phoneStateListener, PhoneStateListener.LISTEN_SIGNAL_STRENGTHS | PhoneStateListener.LISTEN_DATA_CONNECTION_STATE);
                listener.onChange(states);
            }
        }

        private PhoneStateListener createPhoneStateListener(final int subId) {
            return new PhoneStateListener() {
                @Override
                public void onSignalStrengthsChanged(SignalStrength signalStrength) {
                    SubscriptionState state = states.get(String.valueOf(subId));
                    if (state != null) {
                        int level = getSignalStrengthLevel(signalStrength);
                        if (level != state.signalStrength) {
                            state.signalStrength = level;
                            listener.onChange(states);
                        }
                    }
                }

                @Override
                public void onDataConnectionStateChanged(int stateVal, int networkType) {
                    SubscriptionState state = states.get(String.valueOf(subId));
                    if (state != null) {
                        String typeStr = getNetworkTypeString(networkType);
                        if (!typeStr.equals(state.networkType)) {
                            state.networkType = typeStr;
                            listener.onChange(states);
                        }
                    }
                }
            };
        }

        private int getSignalStrengthLevel(SignalStrength signalStrength) {
            if (signalStrength == null) return 0;
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                return signalStrength.getLevel();
            }
            return 0;
        }

        private String getNetworkTypeString(int networkType) {
            switch (networkType) {
                case TelephonyManager.NETWORK_TYPE_NR: return "5G";
                case TelephonyManager.NETWORK_TYPE_LTE: return "LTE";
                case TelephonyManager.NETWORK_TYPE_CDMA:
                case TelephonyManager.NETWORK_TYPE_TD_SCDMA: return "CDMA";
                case TelephonyManager.NETWORK_TYPE_EDGE: return "EDGE";
                case TelephonyManager.NETWORK_TYPE_GPRS: return "GPRS";
                case TelephonyManager.NETWORK_TYPE_GSM: return "GSM";
                case TelephonyManager.NETWORK_TYPE_HSDPA:
                case TelephonyManager.NETWORK_TYPE_HSPA:
                case TelephonyManager.NETWORK_TYPE_HSPAP:
                case TelephonyManager.NETWORK_TYPE_HSUPA: return "HSPA";
                case TelephonyManager.NETWORK_TYPE_UMTS: return "UMTS";
                case TelephonyManager.NETWORK_TYPE_EHRPD:
                case TelephonyManager.NETWORK_TYPE_EVDO_0:
                case TelephonyManager.NETWORK_TYPE_EVDO_A:
                case TelephonyManager.NETWORK_TYPE_EVDO_B:
                case TelephonyManager.NETWORK_TYPE_1xRTT: return "CDMA2000";
                case TelephonyManager.NETWORK_TYPE_IDEN: return "iDEN";
                default: return "Unknown";
            }
        }

        public void stop() {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N && subscriptionManager != null && subscriptionsChangedListener != null) {
                subscriptionManager.removeOnSubscriptionsChangedListener(subscriptionsChangedListener);
            }
            for (Map.Entry<Integer, PhoneStateListener> entry : activeListeners.entrySet()) {
                TelephonyManager subTm = telephonyManager.createForSubscriptionId(entry.getKey());
                subTm.listen(entry.getValue(), PhoneStateListener.LISTEN_NONE);
            }
            activeListeners.clear();
            states.clear();
        }

        public Map<String, SubscriptionState> lastKnownStates() {
            return states;
        }
    }
}
