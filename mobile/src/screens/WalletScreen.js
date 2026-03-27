import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, SectionList,
  StyleSheet, RefreshControl, Alert,
} from 'react-native';
import { wallet } from '../services/api';

export default function WalletScreen({ navigation }) {
  const [balance, setBalance] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [deposits, setDeposits] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('history'); // 'history' | 'deposits'

  const loadData = useCallback(async () => {
    try {
      const { data: balData } = await wallet.getBalance();
      setBalance(balData);
    } catch (err) {
      console.warn('[Wallet] Balance error:', err.message);
    }
    try {
      const { data: txData } = await wallet.getBalance()
        .then(() => ({ data: { transactions: [] } }))
        .catch(() => ({ data: { transactions: [] } }));
      // Load transactions from wallet endpoint
      const { data } = await (await import('../services/api')).wallet.getBalance();
      // Actual transaction load
      const txRes = await (await import('../services/api')).default.user.getTransactions();
      setTransactions(txRes.data.transactions || []);
    } catch (err) { /* ok */ }
    try {
      const { data: depData } = await wallet.getDeposits();
      setDeposits(depData.deposits || []);
    } catch (err) { /* ok */ }
  }, []);

  useEffect(() => {
    loadData();
    const unsubscribe = navigation.addListener('focus', loadData);
    return unsubscribe;
  }, [navigation, loadData]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const txnIcon = (type) => {
    if (type?.includes('deposit')) return '💳';
    if (type?.includes('withdrawal')) return '🏦';
    if (type?.includes('reward')) return '💰';
    if (type?.includes('fee') || type?.includes('freeze')) return '🔒';
    if (type?.includes('refund')) return '↩️';
    return '📄';
  };

  const depositStatusColor = (status) => {
    if (status === 'approved') return '#4ade80';
    if (status === 'rejected') return '#ef4444';
    return '#f97316'; // pending
  };

  const pendingCount = deposits.filter(d => d.status === 'pending').length;

  const renderTransaction = ({ item }) => {
    const isPositive = item.amount > 0;
    return (
      <View style={styles.txnCard}>
        <Text style={styles.txnIcon}>{txnIcon(item.type)}</Text>
        <View style={styles.txnInfo}>
          <Text style={styles.txnType}>{(item.type || '').replace(/_/g, ' ').toUpperCase()}</Text>
          <Text style={styles.txnDesc}>{item.description || ''}</Text>
        </View>
        <Text style={[styles.txnAmount, { color: isPositive ? '#4ade80' : '#ef4444' }]}>
          {isPositive ? '+' : ''}${(Math.abs(item.amount) / 100).toFixed(2)}
        </Text>
      </View>
    );
  };

  const renderDeposit = ({ item }) => (
    <View style={styles.txnCard}>
      <View style={[styles.statusDot, { backgroundColor: depositStatusColor(item.status) }]} />
      <View style={styles.txnInfo}>
        <Text style={styles.txnType}>
          {item.payment_method?.toUpperCase()} DEPOSIT
        </Text>
        <Text style={styles.txnDesc}>
          {item.status === 'pending' ? 'Awaiting approval' :
           item.status === 'approved' ? 'Credited to balance' :
           `Rejected${item.review_note ? ': ' + item.review_note : ''}`}
        </Text>
        <Text style={styles.txnDate}>
          {new Date(item.created_at).toLocaleDateString()}
        </Text>
      </View>
      <View style={styles.depositRight}>
        <Text style={[styles.txnAmount, { color: depositStatusColor(item.status) }]}>
          ${(item.amount / 100).toFixed(2)}
        </Text>
        <Text style={[styles.statusLabel, { color: depositStatusColor(item.status) }]}>
          {item.status.toUpperCase()}
        </Text>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={styles.back}>← BACK</Text>
      </TouchableOpacity>

      {/* Balance card */}
      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>AVAILABLE BALANCE</Text>
        <Text style={styles.balanceAmount}>
          {balance?.balanceFormatted || '$0.00'}
        </Text>
        {balance?.frozen > 0 && (
          <Text style={styles.frozenText}>
            🔒 {balance.frozenFormatted} frozen in active chases
          </Text>
        )}
      </View>

      {/* Actions */}
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={styles.depositBtn}
          onPress={() => navigation.navigate('DepositProof')}
        >
          <Text style={styles.depositText}>DEPOSIT</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.withdrawBtn}
          onPress={() => Alert.alert('Withdraw', 'Contact admin for withdrawal processing.')}
        >
          <Text style={styles.withdrawText}>WITHDRAW</Text>
        </TouchableOpacity>
      </View>

      {/* Admin button (visible in dev mode) */}
      <TouchableOpacity
        style={styles.adminBtn}
        onPress={() => navigation.navigate('AdminDeposits')}
      >
        <Text style={styles.adminText}>ADMIN: REVIEW DEPOSITS</Text>
      </TouchableOpacity>

      {/* Tabs */}
      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'history' && styles.tabActive]}
          onPress={() => setActiveTab('history')}
        >
          <Text style={[styles.tabText, activeTab === 'history' && styles.tabTextActive]}>
            HISTORY
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'deposits' && styles.tabActive]}
          onPress={() => setActiveTab('deposits')}
        >
          <Text style={[styles.tabText, activeTab === 'deposits' && styles.tabTextActive]}>
            DEPOSITS {pendingCount > 0 ? `(${pendingCount})` : ''}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      {activeTab === 'history' ? (
        <FlatList
          data={transactions}
          keyExtractor={(item) => item.id}
          renderItem={renderTransaction}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f97316" />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No transactions yet</Text>
              <Text style={styles.emptyHint}>Start a chase to see activity</Text>
            </View>
          }
        />
      ) : (
        <FlatList
          data={deposits}
          keyExtractor={(item) => item.id}
          renderItem={renderDeposit}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f97316" />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No deposit requests</Text>
              <Text style={styles.emptyHint}>Tap DEPOSIT to add funds</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#080808', paddingHorizontal: 20, paddingTop: 50 },
  back: { fontSize: 13, color: '#666', fontWeight: '600', marginBottom: 16 },
  balanceCard: {
    padding: 24, borderWidth: 1, borderColor: '#f9731633',
    backgroundColor: '#0a0a0a', marginBottom: 20, alignItems: 'center',
  },
  balanceLabel: {
    fontSize: 10, color: '#666', letterSpacing: 3, fontWeight: '700',
  },
  balanceAmount: {
    fontSize: 40, color: '#e5e5e5', fontWeight: '900', marginTop: 8,
  },
  frozenText: { fontSize: 12, color: '#f97316', marginTop: 8 },
  actionRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  depositBtn: {
    flex: 1, backgroundColor: '#4ade80', padding: 14, alignItems: 'center',
  },
  depositText: { color: '#080808', fontWeight: '800', fontSize: 13, letterSpacing: 2 },
  withdrawBtn: {
    flex: 1, borderWidth: 1, borderColor: '#333', padding: 14, alignItems: 'center',
  },
  withdrawText: { color: '#888', fontWeight: '700', fontSize: 13, letterSpacing: 2 },
  adminBtn: {
    borderWidth: 1, borderColor: '#f9731644', padding: 10, alignItems: 'center', marginBottom: 20,
  },
  adminText: { color: '#f97316', fontSize: 10, fontWeight: '700', letterSpacing: 2 },
  tabRow: { flexDirection: 'row', marginBottom: 12, gap: 8 },
  tab: { flex: 1, padding: 10, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: '#111' },
  tabActive: { borderBottomColor: '#f97316' },
  tabText: { fontSize: 11, color: '#555', fontWeight: '700', letterSpacing: 2 },
  tabTextActive: { color: '#f97316' },
  txnCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, borderBottomWidth: 1, borderBottomColor: '#111',
  },
  txnIcon: { fontSize: 20 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  txnInfo: { flex: 1 },
  txnType: { fontSize: 11, color: '#888', fontWeight: '700', letterSpacing: 1 },
  txnDesc: { fontSize: 12, color: '#555', marginTop: 2 },
  txnDate: { fontSize: 10, color: '#333', marginTop: 2 },
  txnAmount: { fontSize: 15, fontWeight: '800' },
  depositRight: { alignItems: 'flex-end' },
  statusLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1, marginTop: 2 },
  empty: { alignItems: 'center', paddingTop: 40 },
  emptyText: { fontSize: 14, color: '#444', fontWeight: '600' },
  emptyHint: { fontSize: 12, color: '#333', marginTop: 4 },
});
