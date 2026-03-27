import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, FlatList,
  StyleSheet, RefreshControl, Alert,
} from 'react-native';
import { chases } from '../services/api';
import { useStore } from '../store';

export default function BrowseChasesScreen({ navigation }) {
  const [activeChases, setActiveChases] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const { currentPosition, setActiveChase, setChasePhase } = useStore();

  const loadChases = useCallback(async () => {
    try {
      const params = currentPosition
        ? { lat: currentPosition.lat, lng: currentPosition.lng, radiusKm: 80 }
        : {};
      const { data } = await chases.getActive(params.lat, params.lng, params.radiusKm);
      setActiveChases(data.chases || []);
    } catch (err) {
      console.warn('[Browse] Failed to load chases:', err.message);
    }
  }, [currentPosition]);

  useEffect(() => { loadChases(); }, [loadChases]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadChases();
    setRefreshing(false);
  };

  const joinChase = async (chase) => {
    Alert.alert(
      `JOIN PURSUIT`,
      `${chase.wanted_name || 'Unknown'} — ${chase.city_name} ${chase.zone_name}\n\nTicket: $${((chase.police_ticket || 0) / 100).toFixed(2)}\nPolice slots: ${chase.police_slots_open || '?'} open`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'JOIN',
          style: 'destructive',
          onPress: async () => {
            try {
              await chases.join(chase.id);
              setActiveChase(chase);
              setChasePhase(chase.status);
              navigation.replace('LiveChase', { chaseId: chase.id, role: 'police' });
            } catch (err) {
              Alert.alert('Error', err.response?.data?.error || 'Failed to join');
            }
          },
        },
      ]
    );
  };

  const renderChase = ({ item }) => {
    const stars = '★'.repeat(item.wanted_level) + '☆'.repeat(5 - item.wanted_level);
    const pool = ((item.total_pool || 0) / 100).toFixed(0);
    const statusColor = item.status === 'matchmaking' ? '#f97316'
      : item.status === 'heat' ? '#ef4444' : '#3b82f6';

    return (
      <TouchableOpacity style={styles.card} onPress={() => joinChase(item)} activeOpacity={0.8}>
        <View style={styles.cardHeader}>
          <Text style={[styles.status, { color: statusColor }]}>
            {item.status?.toUpperCase()}
          </Text>
          <Text style={styles.stars}>{stars}</Text>
        </View>
        <Text style={styles.wantedName}>{item.wanted_name || 'UNKNOWN'}</Text>
        <Text style={styles.zone}>{item.city_name} — {item.zone_name}</Text>
        <View style={styles.cardFooter}>
          <Text style={styles.footerText}>POOL ${pool}</Text>
          <Text style={styles.footerText}>
            {item.current_police_count || 0}/{item.max_police || '?'} POLICE
          </Text>
          <Text style={styles.footerText}>
            {(item.current_radius_km || 0).toFixed(1)} KM
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={styles.back}>← BACK</Text>
      </TouchableOpacity>
      <Text style={styles.heading}>ACTIVE PURSUITS</Text>
      <Text style={styles.subtitle}>
        {activeChases.length} chase{activeChases.length !== 1 ? 's' : ''} nearby
      </Text>

      <FlatList
        data={activeChases}
        keyExtractor={(item) => item.id}
        renderItem={renderChase}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f97316" />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>🏙️</Text>
            <Text style={styles.emptyText}>No active chases nearby</Text>
            <Text style={styles.emptyHint}>Pull to refresh or check back later</Text>
          </View>
        }
        contentContainerStyle={activeChases.length === 0 && styles.emptyContainer}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#080808', paddingHorizontal: 20, paddingTop: 50 },
  back: { fontSize: 13, color: '#666', fontWeight: '600', marginBottom: 12 },
  heading: {
    fontSize: 22, color: '#e5e5e5', fontWeight: '900', letterSpacing: 2,
  },
  subtitle: { fontSize: 12, color: '#555', marginTop: 4, marginBottom: 20 },
  card: {
    padding: 18, borderWidth: 1, borderColor: '#1a1a1a',
    backgroundColor: '#0a0a0a', marginBottom: 12,
  },
  cardHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 8,
  },
  status: { fontSize: 10, fontWeight: '800', letterSpacing: 2 },
  stars: { fontSize: 14, color: '#f97316' },
  wantedName: {
    fontSize: 17, color: '#e5e5e5', fontWeight: '800', letterSpacing: 2,
  },
  zone: { fontSize: 12, color: '#666', marginTop: 4 },
  cardFooter: {
    flexDirection: 'row', justifyContent: 'space-between',
    marginTop: 14, borderTopWidth: 1, borderTopColor: '#1a1a1a', paddingTop: 10,
  },
  footerText: { fontSize: 10, color: '#555', fontWeight: '700', letterSpacing: 1 },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyContainer: { flex: 1 },
  emptyEmoji: { fontSize: 48, marginBottom: 16 },
  emptyText: { fontSize: 16, color: '#555', fontWeight: '700' },
  emptyHint: { fontSize: 12, color: '#333', marginTop: 8 },
});
