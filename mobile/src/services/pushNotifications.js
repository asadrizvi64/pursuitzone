// ═══════════════════════════════════════════════════════════════
// PUSH NOTIFICATION SERVICE
// Expo Notifications + FCM/APNS + chase-specific handling
// ═══════════════════════════════════════════════════════════════

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { user as userApi } from './api';

// Configure notification behavior
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data;
    const urgency = data?.urgency || 'normal';

    return {
      shouldShowAlert: true,
      shouldPlaySound: urgency === 'critical' || urgency === 'urgent',
      shouldSetBadge: true,
      priority: urgency === 'critical' 
        ? Notifications.AndroidNotificationPriority.MAX 
        : Notifications.AndroidNotificationPriority.HIGH,
    };
  },
});

class PushNotificationService {
  constructor() {
    this.expoPushToken = null;
    this.notificationListener = null;
    this.responseListener = null;
    this.onNotification = null;       // Callback for foreground notifications
    this.onNotificationTap = null;    // Callback when user taps a notification
  }

  /**
   * Initialize push notifications — call once on app start.
   */
  async initialize() {
    if (!Device.isDevice) {
      console.warn('[Push] Must use physical device for push notifications');
      return null;
    }

    // Request permission
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      console.warn('[Push] Permission not granted');
      return null;
    }

    // Setup Android notification channels
    if (Platform.OS === 'android') {
      await this.setupAndroidChannels();
    }

    // Get push token
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: 'pursuit-zone', // Your Expo project ID
    });
    this.expoPushToken = tokenData.data;

    // Also get device push token (FCM/APNS) for server-side sending
    const deviceToken = await Notifications.getDevicePushTokenAsync();
    
    // Send token to server
    try {
      await userApi.updateFCMToken(deviceToken.data);
    } catch (err) {
      console.warn('[Push] Failed to send token to server:', err.message);
    }

    // Listen for incoming notifications (foreground)
    this.notificationListener = Notifications.addNotificationReceivedListener(
      (notification) => {
        const data = notification.request.content.data;
        console.log('[Push] Received:', data?.type, data?.chaseId?.slice(0, 8));
        
        if (this.onNotification) {
          this.onNotification({
            id: notification.request.identifier,
            title: notification.request.content.title,
            body: notification.request.content.body,
            data: data,
            type: data?.type,
            chaseId: data?.chaseId,
            urgency: data?.urgency || 'normal',
          });
        }
      }
    );

    // Listen for notification taps (user interaction)
    this.responseListener = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data;
        console.log('[Push] Tapped:', data?.type, data?.chaseId?.slice(0, 8));
        
        if (this.onNotificationTap) {
          this.onNotificationTap({
            type: data?.type,
            chaseId: data?.chaseId,
            data: data,
          });
        }
      }
    );

    console.log('[Push] Initialized. Token:', this.expoPushToken?.slice(0, 20) + '...');
    return this.expoPushToken;
  }

  /**
   * Setup Android-specific notification channels.
   */
  async setupAndroidChannels() {
    // Chase alerts — high priority, custom sound
    await Notifications.setNotificationChannelAsync('chase_alerts', {
      name: 'Chase Alerts',
      description: 'Notifications about nearby chases and urgent matchmaking',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 200, 500],
      lightColor: '#f97316',
      sound: 'siren.wav',
      enableLights: true,
      enableVibrate: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });

    // Chase events — normal priority
    await Notifications.setNotificationChannelAsync('chase_events', {
      name: 'Chase Events',
      description: 'Zone shrinks, tag attempts, chase results',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      enableVibrate: true,
    });

    // General — low priority
    await Notifications.setNotificationChannelAsync('general', {
      name: 'General',
      description: 'Account updates, rewards, system messages',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
    });
  }

  /**
   * Show a local notification (for real-time socket events).
   */
  async showLocalNotification({ title, body, data = {}, channelId = 'chase_events' }) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data,
        sound: data.urgency === 'critical' ? 'siren.wav' : 'default',
        ...(Platform.OS === 'android' && { channelId }),
      },
      trigger: null, // Immediately
    });
  }

  /**
   * Register callbacks for notification events.
   */
  onChaseNotification(callback) {
    this.onNotification = callback;
  }

  onChaseNotificationTap(callback) {
    this.onNotificationTap = callback;
  }

  /**
   * Cleanup listeners.
   */
  cleanup() {
    if (this.notificationListener) {
      Notifications.removeNotificationSubscription(this.notificationListener);
    }
    if (this.responseListener) {
      Notifications.removeNotificationSubscription(this.responseListener);
    }
  }

  /**
   * Get badge count.
   */
  async setBadge(count) {
    await Notifications.setBadgeCountAsync(count);
  }
}

export const pushService = new PushNotificationService();
