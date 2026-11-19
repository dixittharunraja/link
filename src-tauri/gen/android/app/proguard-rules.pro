# Release rules (R8 minify + resource shrinking are on). Conservative: the app's own package is
# reached from Rust over JNI, from the manifest, and by reflection (LinkPlugin dispatches
# @LinkMethod methods by name), so it is kept whole; the savings come from the libraries.

-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod,Exceptions,SourceFile,LineNumberTable

# App code: Tauri plugin, LinkFeature subclasses, @LinkMethod methods (names are the renderer API),
# services/receivers, JSON/enum classes read by name, JNI entry points.
-keep class in.rodix.link.** { *; }
-keep @interface in.rodix.link.LinkMethod
-keepclassmembers class * {
    @in.rodix.link.LinkMethod <methods>;
}
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# Tauri plugin runtime (annotations @Command/@TauriPlugin, Invoke, JSObject, PluginManager) and
# Android components referenced by name.
-keep class app.tauri.** { *; }
-keep class * extends app.tauri.plugin.Plugin { *; }
-keepclassmembers class * {
    @app.tauri.annotation.Command <methods>;
    @app.tauri.annotation.PermissionCallback <methods>;
    @app.tauri.annotation.ActivityCallback <methods>;
}
-keep class * extends android.accessibilityservice.AccessibilityService { *; }
-keep class * extends android.service.notification.NotificationListenerService { *; }
-keep class * extends android.app.Service { *; }
-keep class * extends android.content.BroadcastReceiver { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# WebRTC (JNI looks up Java classes and members by name).
-keep class org.webrtc.** { *; }
-keep class io.getstream.webrtc.** { *; }
-dontwarn org.webrtc.**

# Java-WebSocket: the socket is fetched reflectively (conn.getClass().getMethod("getSocket")).
-keep class org.java_websocket.** { *; }
-dontwarn org.java_websocket.**
-dontwarn org.slf4j.**

# BouncyCastle providers are loaded by name.
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**

# Shizuku binder/provider classes.
-keep class rikka.shizuku.** { *; }
-keep class dev.rikka.shizuku.** { *; }
-dontwarn rikka.**

# Reflection on hidden Android APIs.
-dontwarn android.hardware.input.**
