import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView,
  StyleSheet, Alert, ActivityIndicator,
} from 'react-native';
import { chases } from '../services/api';
import { useStore } from '../store';

const WANTED_LEVELS = [
  { level: 1, label: '1 STAR', fee: 500, maxPolice: 2, phases: 2, desc: 'Quick sprint. Small zone shrink.' },
  { level: 2, label: '2 STARS', fee: 1500, maxPolice: 4, phases: 3, desc: 'Moderate pursuit. More pressure.' },
  { level: 3, label: '3 STARS', fee: 5000, maxPolice: 6, phases: 4, desc: 'Full heat. Serious coordination.' },
  { level: 4, label: '4 STARS', fee: 15000, maxPolice: 10, phases: 5, desc: 'Maximum pursuit. Aggressive shrink.' },
  { level: 5, label: '5 STARS', fee: 50000, maxPolice: 15, phases: 6, desc: 'Most Wanted. All-out manhunt.' },
];

export default function ChaseSetupScreen({ navigation }) {
  const [selectedLevel, setSelectedLevel] = useState(1);
  const [selectedZone, setSelectedZone] = useState(null);
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(false);
  const { setActiveChase, setChasePhase } = useStore();

  useEffect(() => {
    chases.getZones()
      .then(({ data }) => setZones(data.zones || []))
      .catch(() => {});
  }, []);

  const level = WANTED_LEVELS[selectedLevel - 1];

  const createChase = async () => {
    if (!selectedZone) return Alert.alert('Select Zone', 'Pick a chase zone first.');
    setLoading(true);
    try {
      const { data } = await chases.create(selectedLevel, selectedZone);
      setActiveChase(data.chase);
      setChasePhase('matchmaking');
      navigation.replace('LiveChase', { chaseId: data.chase.id, role: 'wanted' });
    } catch (err) {
      Alert.alert('Error', err.response?.data?.error || 'Failed to create chase');
    }
    setLoading(false);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={styles.back}>← BACK</Text>
      </TouchableOpacity>

      <Text style={styles.heading}>SET YOUR WANTED LEVEL</Text>

      {/* Level selector */}
      <View style={styles.levels}>
        {WANTED_LEVELS.map((l) => (
          <TouchableOpacity
            key={l.level}
            style={[styles.levelBtn, selectedLevel === l.level && styles.levelActive]}
            onPress={() => setSelectedLevel(l.level)}
          >
            <Text style={[styles.levelText, selectedLevel === l.level && styles.levelTextActive]}>
              {'★'.repeat(l.level)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Level details */}
      <View style={styles.details}>
        <Text style={styles.levelLabel}>{level.label}</Text>
        <Text style={styles.levelDesc}>{level.desc}</Text>
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statValue}>${(level.fee / 100).toFixed(0)}</Text>
            <Text style={styles.statLabel}>ENTRY FEE</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{level.maxPolice}</Text>
            <Text style={styles.statLabel}>MAX POLICE</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{level.phases}</Text>
            <Text style={styles.statLabel}>SHRINK PHASES</Text>
          </View>
        </View>
      </View>

      {/* Zone selector */}
      <Text style={styles.sectionTitle}>SELECT ZONE</Text>
      {zones.length === 0 && (
        <Text style={styles.noZones}>Loading zones...</Text>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.zoneScroll}>
        {zones.map((zone) => (
          <TouchableOpacity
            key={zone.id}
            style={[styles.zoneCard, selectedZone === zone.id && styles.zoneActive]}
            onPress={() => setSelectedZone(zone.id)}
          >
            <Text style={styles.zoneName}>{zone.zone_name}</Text>
            <Text style={styles.zoneCity}>{zone.city_name}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Create button */}
      <TouchableOpacity
        style={[styles.createBtn, loading && styles.createBtnDisabled]}
        onPress={createChase}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color="#080808" />
        ) : (
          <Text style={styles.createBtnText}>
            GO ROGUE — PAY ${(level.fee / 100).toFixed(0)}
          </Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#080808' },
  content: { paddingHorizontal: 20, paddingTop: 50, paddingBottom: 40 },
  back: { fontSize: 13, color: '#666', fontWeight: '600', marginBottom: 20 },
  heading: {
    fontSize: 22, color: '#e5e5e5', fontWeight: '900',
    letterSpacing: 2, marginBottom: 24,
  },
  levels: { flexDirection: 'row', gap: 8, marginBottom: 24 },
  levelBtn: {
    flex: 1, padding: 12, borderWidth: 1, borderColor: '#222',
    alignItems: 'center',
  },
  levelActive: { borderColor: '#f97316', backgroundColor: '#f9731610' },
  levelText: { fontSize: 14, color: '#555' },
  levelTextActive: { color: '#f97316' },
  details: {
    padding: 20, borderWidth: 1, borderColor: '#1a1a1a',
    marginBottom: 28, backgroundColor: '#0a0a0a',
  },
  levelLabel: {
    fontSize: 18, color: '#f97316', fontWeight: '800', letterSpacing: 3,
    marginBottom: 6,
  },
  levelDesc: { fontSize: 13, color: '#888', marginBottom: 16 },
  statsRow: { flexDirection: 'row', gap: 12 },
  stat: {
    flex: 1, alignItems: 'center',
    borderTopWidth: 1, borderTopColor: '#1a1a1a', paddingTop: 12,
  },
  statValue: { fontSize: 20, color: '#e5e5e5', fontWeight: '800' },
  statLabel: { fontSize: 9, color: '#555', letterSpacing: 2, marginTop: 4 },
  sectionTitle: {
    fontSize: 13, color: '#888', fontWeight: '700',
    letterSpacing: 3, marginBottom: 12,
  },
  noZones: { fontSize: 13, color: '#444', marginBottom: 12 },
  zoneScroll: { marginBottom: 30 },
  zoneCard: {
    padding: 16, borderWidth: 1, borderColor: '#222',
    marginRight: 10, minWidth: 140,
  },
  zoneActive: { borderColor: '#f97316', backgroundColor: '#f9731610' },
  zoneName: { fontSize: 13, color: '#e5e5e5', fontWeight: '700' },
  zoneCity: { fontSize: 11, color: '#666', marginTop: 4 },
  createBtn: {
    backgroundColor: '#ef4444', padding: 18, alignItems: 'center',
  },
  createBtnDisabled: { opacity: 0.5 },
  createBtnText: {
    color: '#fff', fontWeight: '900', fontSize: 15, letterSpacing: 2,
  },
});
