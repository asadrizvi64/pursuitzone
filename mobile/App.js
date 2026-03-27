// ═══════════════════════════════════════════════════════════════
// PURSUIT ZONE — React Native App Entry
// ═══════════════════════════════════════════════════════════════

import React, { useEffect, useState } from 'react';
import { StatusBar, LogBox, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Stripe requires custom dev build — gracefully skip in Expo Go
let StripeProvider;
try {
  StripeProvider = require('@stripe/stripe-react-native').StripeProvider;
} catch (e) {
  StripeProvider = ({ children }) => <>{children}</>;
}

import { connectSocket } from './src/services/api';
import { locationService } from './src/services/location';
import { pushService } from './src/services/pushNotifications';
import { useStore } from './src/store';

// Screens
import SplashScreen from './src/screens/SplashScreen';
import AuthScreen from './src/screens/AuthScreen';
import RoleSelectScreen from './src/screens/RoleSelectScreen';
import ChaseSetupScreen from './src/screens/ChaseSetupScreen';
import BrowseChasesScreen from './src/screens/BrowseChasesScreen';
import LiveChaseScreen from './src/screens/LiveChaseScreen';
import ResultsScreen from './src/screens/ResultsScreen';
import WalletScreen from './src/screens/WalletScreen';
import DepositProofScreen from './src/screens/DepositProofScreen';
import AdminDepositsScreen from './src/screens/AdminDepositsScreen';

LogBox.ignoreLogs(['Non-serializable values']);

const Stack = createNativeStackNavigator();
const queryClient = new QueryClient();

// Dark theme for navigation
const darkTheme = {
  dark: true,
  colors: {
    primary: '#f97316',
    background: '#080808',
    card: '#0a0a0a',
    text: '#e5e5e5',
    border: '#1a1a1a',
    notification: '#ef4444',
  },
};

export default function App() {
  const [appReady, setAppReady] = useState(false);
  const { isAuthenticated, setUser, addNotification, setPosition } = useStore();

  useEffect(() => {
    async function bootstrap() {
      try {
        // 1. Request location permissions (non-fatal if denied)
        try {
          await locationService.requestPermissions();
        } catch (err) {
          console.warn('[App] Location permission not granted:', err.message);
        }

        // 2. Initialize push notifications (non-fatal in Expo Go)
        try {
          await pushService.initialize();
        } catch (err) {
          console.warn('[App] Push notifications not available:', err.message);
        }

        // 3. Setup notification handlers
        pushService.onChaseNotification((notif) => {
          addNotification({
            id: notif.id,
            title: notif.title,
            body: notif.body,
            type: notif.type,
            chaseId: notif.chaseId,
            urgency: notif.urgency,
            data: notif.data,
            timestamp: Date.now(),
          });
        });

        pushService.onChaseNotificationTap((notif) => {
          // Navigate to chase if tapped
          if (notif.chaseId && notif.type === 'chase_nearby') {
            // Navigation handled by the active navigator
          }
        });

        // 4. Connect WebSocket
        try {
          await connectSocket();
        } catch (err) {
          console.log('[App] Socket connection deferred (not authenticated yet)');
        }

        // 5. Get initial position
        try {
          const pos = await locationService.getCurrentPosition();
          setPosition(pos);
        } catch (err) {
          console.warn('[App] Initial position failed:', err.message);
        }

        // 6. Start idle location updates (for matchmaking)
        const idleInterval = setInterval(() => {
          locationService.sendIdleLocation();
        }, 30000); // Every 30 seconds

        setAppReady(true);

        return () => {
          clearInterval(idleInterval);
          pushService.cleanup();
        };
      } catch (err) {
        console.error('[App] Bootstrap error:', err);
        setAppReady(true); // Still show app, handle gracefully
      }
    }

    bootstrap();
  }, []);

  if (!appReady) {
    return <SplashScreen />;
  }

  return (
    <StripeProvider publishableKey="pk_test_YOUR_KEY">
      <QueryClientProvider client={queryClient}>
        <NavigationContainer theme={darkTheme}>
          <StatusBar barStyle="light-content" backgroundColor="#080808" />
          <Stack.Navigator
            screenOptions={{
              headerShown: false,
              animation: 'slide_from_right',
              contentStyle: { backgroundColor: '#080808' },
            }}
          >
            {!isAuthenticated ? (
              <>
                <Stack.Screen name="Splash" component={SplashScreen} />
                <Stack.Screen name="Auth" component={AuthScreen} />
              </>
            ) : (
              <>
                <Stack.Screen name="RoleSelect" component={RoleSelectScreen} />
                <Stack.Screen name="ChaseSetup" component={ChaseSetupScreen} />
                <Stack.Screen name="BrowseChases" component={BrowseChasesScreen} />
                <Stack.Screen 
                  name="LiveChase" 
                  component={LiveChaseScreen}
                  options={{ 
                    gestureEnabled: false, // Prevent accidental back during chase
                    animation: 'fade',
                  }}
                />
                <Stack.Screen name="Results" component={ResultsScreen} />
                <Stack.Screen name="Wallet" component={WalletScreen} />
                <Stack.Screen name="DepositProof" component={DepositProofScreen} />
                <Stack.Screen name="AdminDeposits" component={AdminDepositsScreen} />
              </>
            )}
          </Stack.Navigator>
        </NavigationContainer>
      </QueryClientProvider>
    </StripeProvider>
  );
}
