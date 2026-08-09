import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { ApiError, createClient } from '@reeleel/client';
import type { ProjectSummary, SuggestedMoment } from '@reeleel/client';

/**
 * Native screens over the ReelEel API.
 *
 * Real React Native views, not a WebView, so nothing is shared with the web
 * UI — only @reeleel/client and its types, which is the whole reason that
 * package exists.
 *
 * A single state-driven navigator rather than a routing library: three screens
 * do not justify the dependency, and it keeps this readable while the app is
 * still finding its shape.
 */

const SERVER_KEY = 'reeleel.server';
const TOKEN_KEY = 'reeleel.token';

const DEFAULT_SERVER = 'https://reeleel.com';

const timecode = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

type Screen =
  | { name: 'loading' }
  | { name: 'login' }
  | { name: 'projects' }
  | { name: 'project'; project: ProjectSummary };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [token, setToken] = useState<string | null>(null);

  const client = createClient({ baseUrl: server, token: token ?? undefined });

  // Restore a previous session so the app does not ask for a password on every
  // launch. A rejected token simply drops the user back to the login screen.
  useEffect(() => {
    void (async () => {
      const [savedServer, savedToken] = await Promise.all([
        AsyncStorage.getItem(SERVER_KEY),
        AsyncStorage.getItem(TOKEN_KEY),
      ]);
      if (savedServer !== null) setServer(savedServer);
      if (savedToken === null) {
        setScreen({ name: 'login' });
        return;
      }

      const restored = createClient({ baseUrl: savedServer ?? DEFAULT_SERVER, token: savedToken });
      try {
        const user = await restored.me();
        if (user === null) {
          setScreen({ name: 'login' });
          return;
        }
        setToken(savedToken);
        setScreen({ name: 'projects' });
      } catch {
        setScreen({ name: 'login' });
      }
    })();
  }, []);

  const signIn = useCallback(
    async (email: string, password: string, host: string) => {
      const attempt = createClient({ baseUrl: host });
      const result = await attempt.login(email, password);
      await AsyncStorage.multiSet([
        [SERVER_KEY, host],
        [TOKEN_KEY, result.token],
      ]);
      setServer(host);
      setToken(result.token);
      setScreen({ name: 'projects' });
    },
    [],
  );

  const signOut = useCallback(async () => {
    await AsyncStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setScreen({ name: 'login' });
  }, []);

  if (screen.name === 'loading') {
    return (
      <SafeAreaView style={[styles.screen, styles.centre]}>
        <ActivityIndicator color="#2dd4bf" />
        <StatusBar style="light" />
      </SafeAreaView>
    );
  }

  if (screen.name === 'login') {
    return <LoginScreen defaultServer={server} onSignIn={signIn} />;
  }

  if (screen.name === 'project') {
    return (
      <ProjectScreen
        client={client}
        project={screen.project}
        onBack={() => setScreen({ name: 'projects' })}
      />
    );
  }

  return (
    <ProjectsScreen
      client={client}
      onOpen={(project) => setScreen({ name: 'project', project })}
      onSignOut={signOut}
    />
  );
}

function LoginScreen({
  defaultServer,
  onSignIn,
}: {
  defaultServer: string;
  onSignIn: (email: string, password: string, server: string) => Promise<void>;
}) {
  const [server, setServer] = useState(defaultServer);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onSignIn(email.trim(), password, server.trim().replace(/\/$/, ''));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not reach that server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>ReelEel</Text>
        <Text style={styles.muted}>Sign in to your ReelEel server.</Text>

        <Text style={styles.label}>Server</Text>
        <TextInput
          style={styles.input}
          value={server}
          onChangeText={setServer}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://reeleel.com"
          placeholderTextColor="#6b7280"
        />

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
          placeholderTextColor="#6b7280"
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="password"
          placeholderTextColor="#6b7280"
        />

        {error === null ? null : <Text style={styles.error}>{error}</Text>}

        <Pressable style={styles.button} onPress={() => void submit()} disabled={busy}>
          <Text style={styles.buttonText}>{busy ? 'Signing in…' : 'Sign in'}</Text>
        </Pressable>
      </ScrollView>
      <StatusBar style="light" />
    </SafeAreaView>
  );
}

function ProjectsScreen({
  client,
  onOpen,
  onSignOut,
}: {
  client: ReturnType<typeof createClient>;
  onOpen: (project: ProjectSummary) => void;
  onSignOut: () => Promise<void>;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProjects(await client.projects());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load projects.');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Projects</Text>
        <Pressable onPress={() => void onSignOut()}>
          <Text style={styles.link}>Sign out</Text>
        </Pressable>
      </View>

      {error === null ? null : <Text style={styles.error}>{error}</Text>}

      <FlatList
        data={projects}
        keyExtractor={(project) => project.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor="#2dd4bf" />}
        contentContainerStyle={styles.body}
        ListEmptyComponent={
          loading ? null : <Text style={styles.muted}>No projects yet. Create one on the web app.</Text>
        }
        renderItem={({ item }) => (
          <Pressable style={styles.card} onPress={() => onOpen(item)}>
            <Text style={styles.cardTitle}>{item.name}</Text>
            <Text style={styles.muted}>
              {item.sport}
              {item.opponent === undefined ? '' : ` · vs ${item.opponent}`}
            </Text>
            <Text style={styles.muted}>
              {item.videoCount} video(s) · {item.momentCount} moment(s)
            </Text>
          </Pressable>
        )}
      />
      <StatusBar style="light" />
    </SafeAreaView>
  );
}

function ProjectScreen({
  client,
  project,
  onBack,
}: {
  client: ReturnType<typeof createClient>;
  project: ProjectSummary;
  onBack: () => void;
}) {
  const [moments, setMoments] = useState<SuggestedMoment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMoments(await client.moments(project.id));
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load moments.');
    } finally {
      setLoading(false);
    }
  }, [client, project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (moment: SuggestedMoment, included: boolean | null): Promise<void> => {
    // Optimistic: reviewing a reel is a rapid back-and-forth and waiting for a
    // round trip on every tap makes it feel broken.
    const previous = moments;
    setMoments((current) =>
      current.map((m) => (m.id === moment.id ? { ...m, included } : m)),
    );
    try {
      await client.decideMoment(project.id, moment.id, included);
    } catch {
      setMoments(previous);
      setError('That change did not save.');
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack}>
          <Text style={styles.link}>‹ Projects</Text>
        </Pressable>
        <Text style={styles.muted}>{moments.filter((m) => m.included === true).length} kept</Text>
      </View>

      <Text style={[styles.title, styles.bodyPad]}>{project.name}</Text>
      {error === null ? null : <Text style={styles.error}>{error}</Text>}

      <FlatList
        data={moments}
        keyExtractor={(moment) => moment.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor="#2dd4bf" />}
        contentContainerStyle={styles.body}
        ListEmptyComponent={
          loading ? null : <Text style={styles.muted}>No suggested moments yet. Run analysis.</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {timecode(item.start)} → {timecode(item.end)}
            </Text>
            <Text style={styles.muted}>
              score {item.score.toFixed(2)} · {item.reasons.join(', ')}
            </Text>
            <View style={styles.row}>
              <Pressable
                style={[styles.chip, item.included === true && styles.chipKeep]}
                onPress={() => void decide(item, item.included === true ? null : true)}
              >
                <Text style={styles.chipText}>Keep</Text>
              </Pressable>
              <Pressable
                style={[styles.chip, item.included === false && styles.chipReject]}
                onPress={() => void decide(item, item.included === false ? null : false)}
              >
                <Text style={styles.chipText}>Reject</Text>
              </Pressable>
            </View>
          </View>
        )}
      />
      <StatusBar style="light" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0f1115' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 8 },
  bodyPad: { paddingHorizontal: 16 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#262a31',
  },
  title: { color: '#e8eaed', fontSize: 22, fontWeight: '700' },
  muted: { color: '#9aa0a6', fontSize: 13 },
  label: { color: '#9aa0a6', fontSize: 13, marginTop: 12, marginBottom: 4 },
  link: { color: '#2dd4bf', fontSize: 15 },
  error: { color: '#f87171', paddingHorizontal: 16, paddingVertical: 8 },
  input: {
    backgroundColor: '#171a20',
    borderColor: '#262a31',
    borderWidth: 1,
    borderRadius: 8,
    color: '#e8eaed',
    padding: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#0f766e',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 20,
  },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  card: {
    backgroundColor: '#171a20',
    borderColor: '#262a31',
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 4,
  },
  cardTitle: { color: '#e8eaed', fontSize: 16, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 8, marginTop: 8 },
  chip: {
    borderColor: '#262a31',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  chipKeep: { borderColor: '#4ade80' },
  chipReject: { borderColor: '#f87171' },
  chipText: { color: '#e8eaed', fontSize: 14 },
});
