// Android — required for FCM background messages
// File: android/app/src/main/AndroidManifest.xml

/*
Add these inside <application> tag:

<!-- FCM default channel -->
<meta-data
    android:name="com.google.firebase.messaging.default_notification_channel_id"
    android:value="orderguard_orders" />

<!-- FCM default icon -->
<meta-data
    android:name="com.google.firebase.messaging.default_notification_icon"
    android:resource="@mipmap/ic_launcher" />

<!-- FCM default color -->
<meta-data
    android:name="com.google.firebase.messaging.default_notification_color"
    android:resource="@color/notification_color" />
*/

// android/app/build.gradle — Add at the BOTTOM:
/*
apply plugin: 'com.google.gms.google-services'
*/

// android/build.gradle — Inside dependencies{}:
/*
classpath 'com.google.gms:google-services:4.4.2'
*/

// android/app/src/main/res/values/colors.xml (create if missing):
/*
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="notification_color">#6C63FF</color>
</resources>
*/
