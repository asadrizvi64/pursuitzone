import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, Image, TextInput,
  StyleSheet, RefreshControl, Alert, ActivityIndicator, Modal,
} from 'react-native';
import { wallet } from '../services/api';

export default function AdminDepositsScreen({ navigation }) {
  const [pending, setPending] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedDeposit, setSelectedDeposit] = useState(null);
  const [rejectNote, setRejectNote] = useState('');
  const [processing, setProcessing] = useState(false);

  const loadPending = useCallback(async () => {
    try {
      const { data } = await wallet.getPendingDeposits();
      setPending(data.pending || []);
    } catch (err) {
      if (err.response?.status === 403) {
        Alert.alert('Access Denied', 'Admin access required.');
        navigation.goBack();
      }
    }
  }, [navigation]);

  useEffect(() => { loadPending(); }, [loadPending]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadPending();
    setRefreshing(false);
  };

  const handleReview = async (id, decision, note) => {
    setProcessing(true);
    try {
      await wallet.reviewDeposit(id, decision, note || undefined);
      Alert.alert(
        decision === 'approved' ? 'Approved' : 'Rejected',
        decision === 'approved'
          ? 'Deposit credited to user balance.'
          : 'Deposit rejected.'
      );
      setSelectedDeposit(null);
      setRejectNote('');
      await loadPending();
    } catch (err) {
      Alert.alert('Error', err.response?.data?.error || err.message);
    } finally {
      setProcessing(false);
    }
  };

  const renderDeposit = ({ item }) => (
    <TouchableOpacity style={styles.card} onPress={() => setSelectedDeposit(item)}>
      <View style={styles.cardHeader}>
        <Text style={styles.userName}>{item.display_name}</Text>
        <Text style={styles.amount}>${(item.amount / 100).toFixed(2)}</Text>
      </View>
      <View style={styles.cardMeta}>
        <Text style={styles.method}>{item.payment_method?.toUpperCase()}</Text>
        <Text style={styles.phone}>{item.phone}</Text>
      </View>
      {item.sender_account && (
        <Text style={styles.detail}>From: {item.sender_account}</Text>
      )}
      {item.reference_number && (
        <Text style={styles.detail}>Ref: {item.reference_number}</Text>
      )}
      <Text style={styles.time}>
        {new Date(item.created_at).toLocaleString()}
      </Text>
      <Text style={styles.tapHint}>Tap to review</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={styles.back}>← BACK</Text>
      </TouchableOpacity>
      <Text style={styles.title}>PENDING DEPOSITS</Text>
      <Text style={styles.subtitle}>{pending.length} awaiting review</Text>

      <FlatList
        data={pending}
        keyExtractor={(item) => item.id}
        renderItem={renderDeposit}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f97316" />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No pending deposits</Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: 40 }}
      />

      {/* Review Modal */}
      <Modal
        visible={!!selectedDeposit}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedDeposit(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modal}>
            {selectedDeposit && (
              <>
                <Text style={styles.modalTitle}>REVIEW DEPOSIT</Text>

                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>User</Text>
                  <Text style={styles.modalValue}>{selectedDeposit.display_name}</Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>Phone</Text>
                  <Text style={styles.modalValue}>{selectedDeposit.phone}</Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>Amount</Text>
                  <Text style={[styles.modalValue, { color: '#4ade80' }]}>
                    ${(selectedDeposit.amount / 100).toFixed(2)}
                  </Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>Method</Text>
                  <Text style={styles.modalValue}>
                    {selectedDeposit.payment_method?.toUpperCase()}
                  </Text>
                </View>
                {selectedDeposit.sender_account && (
                  <View style={styles.modalRow}>
                    <Text style={styles.modalLabel}>From</Text>
                    <Text style={styles.modalValue}>{selectedDeposit.sender_account}</Text>
                  </View>
                )}
                {selectedDeposit.reference_number && (
                  <View style={styles.modalRow}>
                    <Text style={styles.modalLabel}>Ref #</Text>
                    <Text style={styles.modalValue}>{selectedDeposit.reference_number}</Text>
                  </View>
                )}

                {/* Screenshot */}
                <Text style={[styles.modalLabel, { marginTop: 12 }]}>PROOF SCREENSHOT</Text>
                {selectedDeposit.screenshot_data ? (
                  <Image
                    source={{ uri: `data:image/jpeg;base64,${selectedDeposit.screenshot_data}` }}
                    style={styles.screenshotPreview}
                    resizeMode="contain"
                  />
                ) : (
                  <Text style={styles.noScreenshot}>No screenshot available</Text>
                )}

                {/* Reject note */}
                <TextInput
                  style={styles.noteInput}
                  placeholder="Rejection reason (optional)"
                  placeholderTextColor="#444"
                  value={rejectNote}
                  onChangeText={setRejectNote}
                />

                {/* Actions */}
                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={styles.rejectBtn}
                    onPress={() => handleReview(selectedDeposit.id, 'rejected', rejectNote)}
                    disabled={processing}
                  >
                    {processing ? <ActivityIndicator color="#ef4444" size="small" /> :
                      <Text style={styles.rejectText}>REJECT</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.approveBtn}
                    onPress={() => {
                      Alert.alert(
                        'Confirm Approval',
                        `Credit $${(selectedDeposit.amount / 100).toFixed(2)} to ${selectedDeposit.display_name}?`,
                        [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Approve', onPress: () => handleReview(selectedDeposit.id, 'approved') },
                        ]
                      );
                    }}
                    disabled={processing}
                  >
                    {processing ? <ActivityIndicator color="#080808" size="small" /> :
                      <Text style={styles.approveText}>APPROVE</Text>}
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  style={styles.cancelBtn}
                  onPress={() => { setSelectedDeposit(null); setRejectNote(''); }}
                >
                  <Text style={styles.cancelText}>CLOSE</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#080808', paddingHorizontal: 20, paddingTop: 50 },
  back: { fontSize: 13, color: '#666', fontWeight: '600', marginBottom: 16 },
  title: { fontSize: 20, color: '#e5e5e5', fontWeight: '900', letterSpacing: 2 },
  subtitle: { fontSize: 12, color: '#666', marginTop: 4, marginBottom: 20 },

  card: {
    padding: 16, borderWidth: 1, borderColor: '#1a1a1a',
    backgroundColor: '#0a0a0a', marginBottom: 10,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  userName: { fontSize: 15, color: '#e5e5e5', fontWeight: '800' },
  amount: { fontSize: 18, color: '#4ade80', fontWeight: '900' },
  cardMeta: { flexDirection: 'row', gap: 12, marginTop: 4 },
  method: { fontSize: 11, color: '#f97316', fontWeight: '700' },
  phone: { fontSize: 11, color: '#666' },
  detail: { fontSize: 11, color: '#555', marginTop: 2 },
  time: { fontSize: 10, color: '#333', marginTop: 6 },
  tapHint: { fontSize: 10, color: '#f97316', marginTop: 4, fontWeight: '600' },

  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: { fontSize: 14, color: '#444', fontWeight: '600' },

  modalOverlay: {
    flex: 1, backgroundColor: '#000000cc', justifyContent: 'flex-end',
  },
  modal: {
    backgroundColor: '#0a0a0a', paddingHorizontal: 20, paddingTop: 24, paddingBottom: 40,
    borderTopWidth: 2, borderTopColor: '#f97316',
    maxHeight: '90%',
  },
  modalTitle: {
    fontSize: 14, color: '#f97316', fontWeight: '800', letterSpacing: 3, marginBottom: 16,
  },
  modalRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#111',
  },
  modalLabel: { fontSize: 11, color: '#666', fontWeight: '600', letterSpacing: 1 },
  modalValue: { fontSize: 13, color: '#e5e5e5', fontWeight: '700' },
  screenshotPreview: {
    width: '100%', height: 200, marginTop: 8,
    borderWidth: 1, borderColor: '#222',
  },
  noScreenshot: { fontSize: 12, color: '#444', marginTop: 8 },
  noteInput: {
    borderWidth: 1, borderColor: '#222', padding: 10,
    color: '#e5e5e5', fontSize: 13, marginTop: 12,
  },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 16 },
  rejectBtn: {
    flex: 1, borderWidth: 1, borderColor: '#ef4444', padding: 14, alignItems: 'center',
  },
  rejectText: { color: '#ef4444', fontWeight: '800', fontSize: 13, letterSpacing: 2 },
  approveBtn: {
    flex: 1, backgroundColor: '#4ade80', padding: 14, alignItems: 'center',
  },
  approveText: { color: '#080808', fontWeight: '800', fontSize: 13, letterSpacing: 2 },
  cancelBtn: { padding: 12, alignItems: 'center', marginTop: 8 },
  cancelText: { color: '#666', fontSize: 12, fontWeight: '600' },
});
