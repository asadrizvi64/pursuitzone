import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useStore } from '../store';
import { auth } from '../services/api';

export default function SplashScreen({ navigation }) {
  const { setUser } = useStore();

  useEffect(() => {
    async function checkAuth() {
      try {
        const token = await auth.getToken();
        if (token) {
          const { data } = await auth.getMe();
          setUser(data.user);
          return; // Navigation handled by auth state change in App.js
        }
      } catch (err) {
        // Token expired or invalid
        await auth.clearToken();
      }
      navigation.replace('Auth');
    }
    const timer = setTimeout(checkAuth, 1500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>PURSUIT</Text>
      <Text style={styles.subtitle}>ZONE</Text>
      <View style={styles.tagline}>
        <View style={styles.line} />
        <Text style={styles.taglineText}>REAL STREETS. REAL CHASE.</Text>
        <View style={styles.line} />
      </View>
      <ActivityIndicator size="small" color="#f97316" style={styles.loader} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#080808',
    justifyContent: 'center', alignItems: 'center',
  },
  title: {
    fontSize: 48, fontWeight: '900', color: '#f97316',
    letterSpacing: 12,
  },
  subtitle: {
    fontSize: 48, fontWeight: '900', color: '#e5e5e5',
    letterSpacing: 12, marginTop: -8,
  },
  tagline: {
    flexDirection: 'row', alignItems: 'center',
    marginTop: 20, gap: 12,
  },
  line: { width: 30, height: 1, backgroundColor: '#333' },
  taglineText: {
    fontSize: 10, color: '#555', letterSpacing: 4, fontWeight: '600',
  },
  loader: { position: 'absolute', bottom: 80 },
});
